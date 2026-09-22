/**
 * Implementação das tools MCP (docs/02) como funções puras `(ctx, args) => CallToolResult`,
 * sem transporte, para facilitar testes. `server.ts` só registra estas funções.
 *
 * Convenções: `content[0]` = texto formatado para a LLM; `structuredContent` = JSON
 * (GameState ou TurnEvent & { state }); erros de regra → `isError: true` (sem exceção).
 */
import * as z from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Color, CommentCategory, GameState, HighlightSpec, TurnEvent } from "../../../shared/types.js";
import { GameError, type GameStore, type SeatInit } from "../game/store.js";
import { formatMoveRef, formatStateForLLM, formatTurnEvent, resultText, type Lang } from "../game/format.js";
import { otherColor } from "../game/rules.js";

/* ------------------------------------------------------------------ */
/* Contexto                                                            */
/* ------------------------------------------------------------------ */

export interface ToolSession {
  id: string;
}

export interface ToolContext {
  store: GameStore;
  session: ToolSession;
  lang?: Lang;
  defaultHumanName?: string;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Schemas zod (input e output)                                        */
/* ------------------------------------------------------------------ */

export const colorSchema = z.enum(["white", "black"]);
export const pieceTypeSchema = z.enum(["p", "n", "b", "r", "q", "k"]);
export const commentCategorySchema = z.enum(["lesson", "plan", "reaction", "question", "praise", "warning", "info"]);

const seatKindSchema = z.enum(["human", "mcp", "bot", "empty"]);

const botSeatInfoSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  profileId: z.string().optional(),
  toolMode: z.enum(["native", "text"]),
  status: z.enum(["idle", "waiting", "thinking", "acting", "error", "budget_exceeded", "stopped"]),
  statusText: z.string().optional(),
  thinkingSince: z.string().optional(),
  usage: z.object({
    calls: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number().optional(),
    estimatedCostUsd: z.number().optional(),
    illegalMoves: z.number(),
  }),
});

const seatSchema = z.object({
  kind: seatKindSchema,
  name: z.string(),
  sessionId: z.string().optional(),
  connectedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  bot: botSeatInfoSchema.optional(),
});

const legalMoveSchema = z.object({
  san: z.string(),
  uci: z.string(),
  from: z.string(),
  to: z.string(),
  piece: pieceTypeSchema,
  captured: pieceTypeSchema.optional(),
  promotion: pieceTypeSchema.optional(),
  isCapture: z.boolean(),
  isCheck: z.boolean(),
  isCastle: z.boolean(),
});

const moveRecordSchema = z.object({
  ply: z.number(),
  moveNumber: z.number(),
  color: colorSchema,
  san: z.string(),
  uci: z.string(),
  from: z.string(),
  to: z.string(),
  piece: pieceTypeSchema,
  captured: pieceTypeSchema.optional(),
  promotion: pieceTypeSchema.optional(),
  isCheck: z.boolean(),
  isCheckmate: z.boolean(),
  fenAfter: z.string(),
  by: seatKindSchema,
  comment: z.string().optional(),
  timestamp: z.string(),
});

const highlightSquareSchema = z.object({ square: z.string(), color: z.string().optional() });
const highlightArrowSchema = z.object({ from: z.string(), to: z.string(), color: z.string().optional() });
const highlightSpecSchema = z.object({
  squares: z.array(highlightSquareSchema),
  arrows: z.array(highlightArrowSchema),
});

const commentarySchema = z.object({
  id: z.string(),
  ply: z.number(),
  author: z.enum(["white", "black", "system"]),
  authorName: z.string(),
  category: commentCategorySchema,
  text: z.string(),
  highlight: highlightSpecSchema.optional(),
  timestamp: z.string(),
});

const humanMessageSchema = z.object({
  id: z.string(),
  ply: z.number(),
  text: z.string(),
  to: z.enum(["white", "black", "all"]),
  deliveredTo: z.array(colorSchema),
  timestamp: z.string(),
});

export const gameStateSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["waiting", "active", "finished"]),
  result: z.enum(["1-0", "0-1", "1/2-1/2", "*"]),
  endReason: z
    .enum([
      "checkmate",
      "stalemate",
      "insufficient_material",
      "threefold_repetition",
      "fifty_move_rule",
      "resignation",
      "draw_agreed",
      "aborted",
    ])
    .optional(),
  winner: colorSchema.optional(),
  seats: z.object({ white: seatSchema, black: seatSchema }),
  startFen: z.string(),
  fen: z.string(),
  turn: colorSchema,
  ply: z.number(),
  moveNumber: z.number(),
  inCheck: z.boolean(),
  isCheckmate: z.boolean(),
  isStalemate: z.boolean(),
  isDraw: z.boolean(),
  lastMove: moveRecordSchema.optional(),
  history: z.array(moveRecordSchema),
  pgn: z.string(),
  legalMoves: z.array(legalMoveSchema),
  pieces: z.array(z.object({ square: z.string(), type: pieceTypeSchema, color: z.enum(["w", "b"]) })),
  ascii: z.string(),
  captured: z.object({ byWhite: z.array(pieceTypeSchema), byBlack: z.array(pieceTypeSchema) }),
  materialBalance: z.number(),
  commentary: z.array(commentarySchema),
  humanMessages: z.array(humanMessageSchema),
  highlight: highlightSpecSchema.extend({ by: z.enum(["white", "black", "system"]), ply: z.number() }).nullable(),
  drawOffer: z.object({ by: colorSchema, at: z.string() }).nullable().optional(),
});

export const turnEventSchema = z.object({
  event: z.enum([
    "your_turn",
    "opponent_moved",
    "message",
    "takeback",
    "opponent_joined",
    "new_game",
    "game_over",
    "timeout",
    "not_seated",
  ]),
  yourColor: colorSchema.optional(),
  isYourTurn: z.boolean(),
  opponentMove: moveRecordSchema.optional(),
  messages: z.array(humanMessageSchema),
  waitedSeconds: z.number(),
  nextAction: z.string(),
  state: gameStateSchema,
});

/** Shapes (raw) para `registerTool({ outputSchema })`. */
export const gameStateOutputShape = gameStateSchema.shape;
export const turnEventOutputShape = turnEventSchema.shape;

const highlightInputSchema = z.object({
  squares: z
    .array(z.union([z.string(), highlightSquareSchema]))
    .optional()
    .describe('Squares to highlight, e.g. ["e4", { "square": "f7", "color": "red" }]'),
  arrows: z
    .array(highlightArrowSchema)
    .optional()
    .describe('Arrows, e.g. [{ "from": "c4", "to": "f7", "color": "red" }]'),
});

export const inputShapes = {
  new_game: {
    my_color: z.enum(["white", "black", "random"]).default("black").describe("Color the LLM will play. Default: black (the human plays white)."),
    opponent: z
      .enum(["human", "llm"])
      .default("human")
      .describe('"human": the other seat belongs to the browser. "llm": the other seat stays empty until another MCP session calls join_game.'),
    my_name: z.string().max(60).default("Claude").describe("Display name for this LLM in the UI."),
    opponent_name: z.string().max(60).optional().describe('Human name shown in the UI (ignored when opponent = "llm").'),
    start_fen: z.string().optional().describe("Optional FEN to start from a specific position (lesson, endgame, puzzle)."),
  },
  join_game: {
    color: colorSchema.optional().describe("Seat to take. Omit to take the only free seat."),
    my_name: z.string().max(60).default("Claude").describe("Display name for this LLM in the UI."),
    force: z.boolean().default(false).describe("Take the seat even if another active MCP session or the human occupies it."),
  },
  make_move: {
    move: z.string().min(2).describe('Move in SAN ("Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3", "e7e8q").'),
    comment: z.string().max(2000).optional().describe("Teacher comment shown next to the move (explain the idea behind it)."),
    comment_category: commentCategorySchema.optional().describe('Category of the comment. Default: "plan".'),
  },
  wait_for_turn: {
    timeout_seconds: z.number().min(1).max(120).default(60).describe("Max seconds to wait (1-120). Default 60."),
  },
  comment: {
    text: z.string().min(1).max(4000).describe("The teacher comment (simple markdown allowed)."),
    category: commentCategorySchema.default("lesson").describe('Category. Default: "lesson".'),
    highlight: highlightInputSchema.optional().describe("Optional drawing (squares/arrows) attached to the comment."),
  },
  highlight: {
    squares: highlightInputSchema.shape.squares,
    arrows: highlightInputSchema.shape.arrows,
    clear: z.boolean().optional().describe("true = clear all drawings (other fields ignored)."),
  },
  takeback: {
    plies: z.number().int().min(1).max(10).default(2).describe("Half-moves to undo (1-10). Default 2 (one full move)."),
  },
  end_game: {
    how: z.enum(["resign", "draw", "abort"]).describe('"resign": your color loses. "draw": agreed draw. "abort": no result.'),
  },
  leave_game: {},
};

type Args<K extends keyof typeof inputShapes> = z.output<z.ZodObject<(typeof inputShapes)[K]>>;

export type NewGameArgs = Args<"new_game">;
export type JoinGameArgs = Args<"join_game">;
export type MakeMoveArgs = Args<"make_move">;
export type WaitForTurnArgs = Args<"wait_for_turn">;
export type CommentArgs = Args<"comment">;
export type HighlightArgs = Args<"highlight">;
export type TakebackArgs = Args<"takeback">;
export type EndGameArgs = Args<"end_game">;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const COLOR_UPPER: Record<Color, string> = { white: "BRANCAS", black: "PRETAS" };

function stateResult(text: string, state: GameState, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: state as unknown as Record<string, unknown>,
  };
  if (isError) result.isError = true;
  return result;
}

function eventResult(text: string, event: TurnEvent, state: GameState): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...event, state } as unknown as Record<string, unknown>,
  };
}

function withState(ctx: ToolContext, color: Color | null, prefix: string, opts: { short?: boolean; isError?: boolean } = {}): CallToolResult {
  // Formata com as mensagens ainda pendentes (para aparecerem no texto) e só então marca como entregues.
  const state = ctx.store.getState();
  const body = formatStateForLLM(state, color, { lang: ctx.lang, short: opts.short });
  if (color) ctx.store.markDelivered(color);
  const text = prefix ? `${prefix}\n\n${body}` : body;
  return stateResult(text, ctx.store.getState(), opts.isError);
}

function notSeated(ctx: ToolContext): CallToolResult {
  const state = ctx.store.getState();
  const text = `Você não ocupa nenhum assento nesta partida. Chame new_game (para criar uma partida) ou join_game (para entrar na atual).\n\n${formatStateForLLM(state, null, { lang: ctx.lang, short: true })}`;
  return stateResult(text, state, true);
}

function gameErrorResult(ctx: ToolContext, color: Color | null, err: GameError): CallToolResult {
  let text = err.message;
  if (err.legalMoves && err.legalMoves.length) {
    const state = ctx.store.getState();
    const captures = state.legalMoves.filter((m) => m.isCapture).map((m) => m.san);
    const checks = state.legalMoves.filter((m) => m.isCheck).map((m) => m.san);
    const extras: string[] = [];
    if (captures.length) extras.push(`capturas: ${captures.join(", ")}`);
    if (checks.length) extras.push(`xeques: ${checks.join(", ")}`);
    text += `\nLances legais agora (${err.legalMoves.length}): ${err.legalMoves.join(" ")}${extras.length ? ` (${extras.join("; ")})` : ""}`;
  }
  return withState(ctx, color, text, { short: true, isError: true });
}

function normalizeHighlight(input: z.output<typeof highlightInputSchema> | undefined): HighlightSpec | null {
  if (!input) return null;
  const squares = (input.squares ?? []).map((s) => (typeof s === "string" ? { square: s } : s));
  const arrows = input.arrows ?? [];
  if (!squares.length && !arrows.length) return null;
  return { squares, arrows };
}

function seatColor(ctx: ToolContext): Color | null {
  return ctx.store.seatForSession(ctx.session.id);
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export function toolNewGame(ctx: ToolContext, args: NewGameArgs): CallToolResult {
  const myColor: Color = args.my_color === "random" ? (Math.random() < 0.5 ? "white" : "black") : args.my_color;
  const opp = otherColor(myColor);
  const mine: SeatInit = { kind: "mcp", name: args.my_name, sessionId: ctx.session.id };
  const other: SeatInit =
    args.opponent === "llm"
      ? { kind: "empty" }
      : { kind: "human", name: args.opponent_name?.trim() || ctx.defaultHumanName || "Você" };
  const seats = myColor === "white" ? { white: mine, black: other } : { white: other, black: mine };
  try {
    ctx.store.newGame({ seats, startFen: args.start_fen, bySessionId: ctx.session.id });
  } catch (err) {
    if (err instanceof GameError) return gameErrorResult(ctx, null, err);
    throw err;
  }
  const state = ctx.store.getState();
  const prefix =
    args.opponent === "llm"
      ? `Partida criada. Você joga de ${COLOR_UPPER[myColor]} como "${args.my_name}". Aguardando outra LLM entrar com join_game(color: "${opp}"). Chame wait_for_turn.`
      : `Partida criada. Você joga de ${COLOR_UPPER[myColor]} como "${args.my_name}" contra ${state.seats[opp].name} (humano, no navegador).`;
  return withState(ctx, myColor, prefix);
}

export function toolJoinGame(ctx: ToolContext, args: JoinGameArgs): CallToolResult {
  let color: Color;
  try {
    color = ctx.store.joinGame({ sessionId: ctx.session.id, color: args.color, name: args.my_name, force: args.force });
  } catch (err) {
    if (err instanceof GameError) return gameErrorResult(ctx, null, err);
    throw err;
  }
  const state = ctx.store.getState();
  const opp = state.seats[otherColor(color)];
  const oppKindPt = opp.kind === "human" ? "humano" : opp.kind === "bot" ? "LLM (bot do servidor)" : "LLM";
  const oppText = opp.kind === "empty" ? "o outro assento ainda está vazio" : `contra ${opp.name} (${oppKindPt})`;
  return withState(ctx, color, `Você entrou na partida de ${COLOR_UPPER[color]} como "${args.my_name}"; ${oppText}.`);
}

export function toolGetState(ctx: ToolContext): CallToolResult {
  return withState(ctx, seatColor(ctx), "");
}

export function toolMakeMove(ctx: ToolContext, args: MakeMoveArgs): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  try {
    const record = ctx.store.applyMove(color, args.move, {
      comment: args.comment,
      commentCategory: (args.comment_category ?? "plan") as CommentCategory,
    });
    const state = ctx.store.getState();
    let prefix = `Você jogou ${formatMoveRef(record)}.`;
    if (state.status === "finished") {
      const head = state.endReason === "checkmate" ? "Xeque-mate! " : "";
      prefix += ` ${head}${capitalize(resultText(state, color))}. Partida encerrada.`;
    } else {
      const opp = otherColor(color);
      prefix += ` Agora é a vez das ${COLOR_UPPER[opp]} (${state.seats[opp].name}). Chame wait_for_turn.`;
    }
    return withState(ctx, color, prefix);
  } catch (err) {
    if (err instanceof GameError) return gameErrorResult(ctx, color, err);
    throw err;
  }
}

export async function toolWaitForTurn(ctx: ToolContext, args: WaitForTurnArgs): Promise<CallToolResult> {
  const color = seatColor(ctx);
  const store = ctx.store;
  if (!color) {
    const state = store.getState();
    const event: TurnEvent = {
      event: "not_seated",
      isYourTurn: false,
      messages: [],
      waitedSeconds: 0,
      nextAction: "Você não ocupa nenhum assento. Chame new_game ou join_game.",
    };
    return eventResult(formatTurnEvent(event, state, null, { lang: ctx.lang, short: true }), event, state);
  }
  const timeoutMs = Math.round(Math.min(120, Math.max(1, args.timeout_seconds ?? 60)) * 1000);
  const event = await store.waitForTurn(color, timeoutMs, { signal: ctx.signal, sessionId: ctx.session.id });
  store.touchSession(ctx.session.id);
  // A sessão pode ter perdido o assento enquanto esperava (new_game do humano, force de outra LLM).
  const stillSeated = store.seatForSession(ctx.session.id);
  const state = store.getState();
  const perspective = stillSeated ?? null;
  const text = formatTurnEvent(event, state, perspective, { lang: ctx.lang, short: event.event === "timeout" });
  return eventResult(text, event, state);
}

export function toolComment(ctx: ToolContext, args: CommentArgs): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  const highlight = normalizeHighlight(args.highlight);
  ctx.store.addComment(color, args.text, args.category as CommentCategory, highlight);
  return withState(ctx, color, `Comentário publicado no tabuleiro${highlight ? " (com destaque)" : ""}.`, { short: true });
}

export function toolHighlight(ctx: ToolContext, args: HighlightArgs): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  if (args.clear) {
    ctx.store.setHighlight(color, null);
    return withState(ctx, color, "Destaques apagados.", { short: true });
  }
  const spec = normalizeHighlight({ squares: args.squares, arrows: args.arrows });
  ctx.store.setHighlight(color, spec);
  if (!spec) return withState(ctx, color, "Nenhuma casa ou seta informada: destaques apagados.", { short: true });
  const parts: string[] = [];
  if (spec.squares.length) parts.push(`${spec.squares.length} casa${spec.squares.length === 1 ? "" : "s"}`);
  if (spec.arrows.length) parts.push(`${spec.arrows.length} seta${spec.arrows.length === 1 ? "" : "s"}`);
  return withState(ctx, color, `Destaque desenhado no tabuleiro (${parts.join(", ")}). Ele some automaticamente no próximo lance.`, { short: true });
}

export function toolTakeback(ctx: ToolContext, args: TakebackArgs): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  try {
    const before = ctx.store.getState().ply;
    ctx.store.takeback(args.plies, color);
    const after = ctx.store.getState().ply;
    const n = before - after;
    return withState(ctx, color, `Desfeito${n === 1 ? "" : "s"} ${n} meio-lance${n === 1 ? "" : "s"}. Posição atual abaixo.`);
  } catch (err) {
    if (err instanceof GameError) return gameErrorResult(ctx, color, err);
    throw err;
  }
}

export function toolEndGame(ctx: ToolContext, args: EndGameArgs): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  try {
    if (args.how === "resign") {
      ctx.store.endGame("resignation", color);
      return withState(ctx, color, `Você desistiu. Resultado: ${ctx.store.getState().result}. Partida encerrada.`, { short: true });
    }
    if (args.how === "draw") {
      ctx.store.endGame("draw_agreed", color);
      return withState(ctx, color, "Empate acordado (1/2-1/2). Partida encerrada.", { short: true });
    }
    ctx.store.endGame("aborted", color);
    return withState(ctx, color, "Partida abortada (sem resultado).", { short: true });
  } catch (err) {
    if (err instanceof GameError) return gameErrorResult(ctx, color, err);
    throw err;
  }
}

export function toolLeaveGame(ctx: ToolContext): CallToolResult {
  const color = seatColor(ctx);
  if (!color) return notSeated(ctx);
  ctx.store.unseat(color);
  return withState(ctx, null, `Você saiu do assento das ${COLOR_UPPER[color]}; ele está livre para outra LLM (join_game).`, { short: true });
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
