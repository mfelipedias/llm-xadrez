/**
 * Cria um McpServer por sessão Streamable HTTP; todos compartilham o mesmo GameStore.
 * Registra as tools (docs/02), o prompt `chess_teacher` e os 3 recursos `xadrez://game/*`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { GameStore } from "../game/store.js";
import { formatStateForLLM, type Lang } from "../game/format.js";
import { registerPrompts } from "./prompts.js";
import {
  gameStateOutputShape,
  inputShapes,
  toolComment,
  toolEndGame,
  toolGetState,
  toolHighlight,
  toolJoinGame,
  toolLeaveGame,
  toolMakeMove,
  toolNewGame,
  toolTakeback,
  toolWaitForTurn,
  turnEventOutputShape,
  type ToolContext,
} from "./tools.js";
import { createLogger } from "../log.js";

const log = createLogger("mcp");

/** Referência mutável: o id só é conhecido depois do `initialize`. */
export interface SessionRef {
  id: string;
}

export interface McpServerOptions {
  version: string;
  lang?: Lang;
  defaultHumanName?: string;
  /** Intervalo das notificações de progresso durante wait_for_turn (0 desliga). */
  progressIntervalMs?: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function createMcpServer(store: GameStore, session: SessionRef, opts: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: "llm-xadrez", version: opts.version },
    {
      capabilities: { logging: {} },
      instructions:
        "Chess board connected to a web UI. Call new_game (or join_game) once, then alternate wait_for_turn and make_move. " +
        "Every response contains the full verified game state (FEN, pieces, legal moves, history) and a 'Próximo passo' hint. " +
        "Never rely on memory: pick moves from the legalMoves of the latest response. Use comment/highlight to teach.",
    },
  );

  const ctxFor = (extra: Extra): ToolContext => {
    const id = extra.sessionId ?? session.id;
    if (id && !session.id) session.id = id;
    store.touchSession(id);
    return { store, session: { id }, lang: opts.lang, defaultHumanName: opts.defaultHumanName, signal: extra.signal };
  };

  const logResult = (name: string, result: CallToolResult): CallToolResult => {
    const first = result.content[0];
    const head = first && first.type === "text" ? first.text.split("\n")[0] : "";
    log.info(`${session.id.slice(0, 8)} ${name}${result.isError ? " [erro]" : ""}: ${head.slice(0, 120)}`);
    return result;
  };

  server.registerTool(
    "new_game",
    {
      title: "New game",
      description:
        "Start a new chess game (the current one is archived as PGN) and seat this session on the chosen color. " +
        'opponent="human" (default): the other seat is the person in the browser. opponent="llm": the other seat waits for another MCP session (join_game). ' +
        "Returns the full state and what to do next.",
      inputSchema: inputShapes.new_game,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("new_game", toolNewGame(ctxFor(extra), args)),
  );

  server.registerTool(
    "join_game",
    {
      title: "Join game",
      description:
        "Join the current game on a free seat (or resume your own seat after a reconnect). " +
        "A seat held by a dead/idle MCP session, or with the same my_name, can be resumed without force. force=true takes it unconditionally.",
      inputSchema: inputShapes.join_game,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("join_game", toolJoinGame(ctxFor(extra), args)),
  );

  server.registerTool(
    "get_state",
    {
      title: "Get state",
      description:
        "Look at the board without waiting: full state (FEN, pieces, ASCII board, history, legal moves when it is your turn) plus pending messages from the student.",
      inputSchema: {},
      outputSchema: gameStateOutputShape,
    },
    (_args, extra) => logResult("get_state", toolGetState(ctxFor(extra))),
  );

  server.registerTool(
    "make_move",
    {
      title: "Make move",
      description:
        "Play a move for your color (SAN like Nf3, exd5, O-O, e8=Q or UCI like g1f3, e7e8q). " +
        "Optionally attach a teacher comment shown next to the move. On an illegal move the result is an error listing the legal moves: pick one of them. " +
        "After a successful move, call wait_for_turn.",
      inputSchema: inputShapes.make_move,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("make_move", toolMakeMove(ctxFor(extra), args)),
  );

  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait for turn",
      description:
        "Block (up to timeout_seconds, max 120) until something relevant happens for you: opponent_moved, your_turn, message from the student, takeback, opponent_joined, new_game, game_over. " +
        "Returns 'timeout' if nothing happened: just call it again. Events are queued per seat, so nothing is lost while you are not waiting.",
      inputSchema: inputShapes.wait_for_turn,
      outputSchema: turnEventOutputShape,
    },
    async (args, extra) => {
      const ctx = ctxFor(extra);
      const progressToken = extra._meta?.progressToken;
      const interval = opts.progressIntervalMs ?? 10_000;
      let ticker: NodeJS.Timeout | null = null;
      if (progressToken !== undefined && interval > 0) {
        let n = 0;
        ticker = setInterval(() => {
          n += 1;
          void extra
            .sendNotification({ method: "notifications/progress", params: { progressToken, progress: n, message: "aguardando..." } })
            .catch(() => undefined);
        }, interval);
      }
      try {
        return logResult("wait_for_turn", await toolWaitForTurn(ctx, args));
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },
  );

  server.registerTool(
    "comment",
    {
      title: "Comment",
      description:
        "Publish a teacher comment on the board without moving (lesson, plan, reaction, question, praise, warning). Optionally attach squares/arrows.",
      inputSchema: inputShapes.comment,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("comment", toolComment(ctxFor(extra), args)),
  );

  server.registerTool(
    "highlight",
    {
      title: "Highlight",
      description:
        "Draw on the board: highlighted squares and arrows (replaces the previous drawing; cleared automatically on the next move). " +
        'Colors: any CSS color, e.g. "green", "red", "blue", "yellow". clear=true erases everything.',
      inputSchema: inputShapes.highlight,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("highlight", toolHighlight(ctxFor(extra), args)),
  );

  server.registerTool(
    "takeback",
    {
      title: "Takeback",
      description: "Undo the last N half-moves (default 2 = one full move), e.g. to let the student retry or to set up a lesson position.",
      inputSchema: inputShapes.takeback,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("takeback", toolTakeback(ctxFor(extra), args)),
  );

  server.registerTool(
    "end_game",
    {
      title: "End game",
      description: 'End the current game: "resign" (your color loses), "draw" (agreed draw, also accepts a pending draw offer) or "abort" (no result).',
      inputSchema: inputShapes.end_game,
      outputSchema: gameStateOutputShape,
    },
    (args, extra) => logResult("end_game", toolEndGame(ctxFor(extra), args)),
  );

  server.registerTool(
    "leave_game",
    {
      title: "Leave game",
      description: "Free your seat (it becomes empty) so another LLM or the human can take it.",
      inputSchema: {},
      outputSchema: gameStateOutputShape,
    },
    (_args, extra) => logResult("leave_game", toolLeaveGame(ctxFor(extra))),
  );

  registerPrompts(server);

  server.registerResource(
    "game-state",
    "xadrez://game/state",
    { title: "Game state (text)", description: "Current game formatted for an LLM (same text as get_state).", mimeType: "text/plain" },
    (uri, extra) => {
      const color = store.seatForSession(extra.sessionId ?? session.id);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: formatStateForLLM(store.getState(), color, { lang: opts.lang }) }] };
    },
  );
  server.registerResource(
    "game-pgn",
    "xadrez://game/pgn",
    { title: "Game PGN", description: "PGN of the current game.", mimeType: "application/x-chess-pgn" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/x-chess-pgn", text: store.getPgn() }] }),
  );
  server.registerResource(
    "game-state-json",
    "xadrez://game/state.json",
    { title: "Game state (JSON)", description: "Full GameState as JSON.", mimeType: "application/json" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(store.getState(), null, 2) }] }),
  );

  return server;
}
