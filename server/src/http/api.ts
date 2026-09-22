/**
 * API REST usada pelo navegador. Ver docs/03-servidor.md, "API REST".
 * Todas as rotas respondem JSON (exceto os PGNs). Erros de regra: 4xx com `ApiError`.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type {
  ApiError,
  Color,
  HumanSeating,
  MessageRequest,
  MoveRequest,
  NewGameRequest,
  ResignRequest,
  ServerInfo,
  TakebackRequest,
} from "../../../shared/types.js";
import { GameError, type GameStore, type SeatInit } from "../game/store.js";
import type { Persistence } from "../game/persist.js";
import { createLogger } from "../log.js";

const log = createLogger("api");

export interface ApiDeps {
  store: GameStore;
  persistence: Pick<Persistence, "listGames" | "readGamePgn">;
  serverInfo: () => ServerInfo;
  defaultHumanName: string;
}

const COLORS: Color[] = ["white", "black"];
const SEATINGS: HumanSeating[] = ["white", "black", "both", "none"];

function sendError(res: Response, status: number, error: string, legalMoves?: string[]): void {
  const body: ApiError = { error };
  if (legalMoves) body.legalMoves = legalMoves;
  res.status(status).json(body);
}

function statusForError(err: GameError): number {
  switch (err.code) {
    case "seat_taken":
      return 409;
    case "not_seated":
    case "nothing_to_undo":
    case "invalid_argument":
    case "invalid_fen":
    case "illegal_move":
    case "not_your_turn":
    case "game_not_active":
    case "game_finished":
    default:
      return 400;
  }
}

function isColor(v: unknown): v is Color {
  return v === "white" || v === "black";
}

/** Cor do assento humano que deve agir (vez, ou o único humano). */
function humanSeatColor(store: GameStore, requested?: unknown): Color | null {
  const state = store.getState();
  if (isColor(requested)) return state.seats[requested].kind === "human" ? requested : null;
  const humans = COLORS.filter((c) => state.seats[c].kind === "human");
  if (humans.length === 0) return null;
  if (humans.length === 1) return humans[0];
  return state.turn;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store } = deps;
  const router = Router();

  router.get("/health", (_req, res) => {
    const info = deps.serverInfo();
    res.json({ ok: true, version: info.version, mcpUrl: info.mcpUrl, mcpSessions: info.mcpSessions });
  });

  router.get("/state", (_req, res) => {
    res.json(store.getState());
  });

  router.post("/game", (req, res) => {
    const body = (req.body ?? {}) as Partial<NewGameRequest>;
    const humanSeats: HumanSeating = SEATINGS.includes(body.humanSeats as HumanSeating) ? (body.humanSeats as HumanSeating) : "white";
    const humanName = typeof body.humanName === "string" && body.humanName.trim() ? body.humanName.trim() : deps.defaultHumanName;
    const startFen = typeof body.startFen === "string" && body.startFen.trim() ? body.startFen.trim() : undefined;

    // Assento MCP com sessão ainda aberta continua na nova partida (na cor livre); senão fica `empty`.
    const previous = store.getState();
    const liveMcp = COLORS.map((c) => previous.seats[c])
      .filter((s) => s.kind === "mcp" && store.isSessionOpen(s.sessionId));

    const human: SeatInit = { kind: "human", name: humanName };
    const seats: Record<Color, SeatInit> = { white: { kind: "empty" }, black: { kind: "empty" } };
    if (humanSeats === "both") {
      seats.white = human;
      seats.black = human;
    } else if (humanSeats === "none") {
      const [a, b] = liveMcp;
      if (a) seats[previous.seats.white.sessionId === a.sessionId ? "white" : "black"] = { kind: "mcp", name: a.name, sessionId: a.sessionId };
      if (b) seats[previous.seats.white.sessionId === b.sessionId ? "white" : "black"] = { kind: "mcp", name: b.name, sessionId: b.sessionId };
    } else {
      seats[humanSeats] = human;
      const free: Color = humanSeats === "white" ? "black" : "white";
      const keep = liveMcp[0];
      if (keep) seats[free] = { kind: "mcp", name: keep.name, sessionId: keep.sessionId };
    }
    log.info(`nova partida via REST (humanSeats=${humanSeats}${startFen ? ", FEN customizado" : ""})`);
    res.json(store.newGame({ seats: { white: seats.white, black: seats.black }, startFen }));
  });

  router.post("/move", (req, res) => {
    const body = (req.body ?? {}) as Partial<MoveRequest>;
    if (typeof body.move !== "string" || !body.move.trim()) {
      sendError(res, 400, "Informe o lance em `move` (SAN ou UCI).");
      return;
    }
    const state = store.getState();
    if (state.status === "finished") {
      sendError(res, 400, "A partida já terminou.");
      return;
    }
    if (state.status !== "active") {
      sendError(res, 400, "A partida ainda não começou: aguarde a LLM entrar no assento vazio.");
      return;
    }
    const turnSeat = state.seats[state.turn];
    if (turnSeat.kind !== "human") {
      sendError(res, 400, `Não é a vez de um humano: é a vez das ${state.turn === "white" ? "brancas" : "pretas"} (${turnSeat.name}).`);
      return;
    }
    const record = store.applyMove(state.turn, body.move);
    log.info(`humano jogou ${record.san}`);
    res.json(store.getState());
  });

  router.post("/message", (req, res) => {
    const body = (req.body ?? {}) as Partial<MessageRequest>;
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendError(res, 400, "Mensagem vazia.");
      return;
    }
    const to = body.to === "white" || body.to === "black" || body.to === "all" ? body.to : "all";
    store.addHumanMessage(body.text, to);
    res.json(store.getState());
  });

  router.post("/takeback", (req, res) => {
    const body = (req.body ?? {}) as Partial<TakebackRequest>;
    const state = store.getState();
    let plies: number;
    if (typeof body.plies === "number" && Number.isInteger(body.plies) && body.plies > 0) {
      plies = body.plies;
    } else {
      // Default: volta até a posição anterior ao último lance humano.
      let idx = -1;
      for (let i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].by === "human") {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        sendError(res, 400, "Não há lance humano para desfazer.");
        return;
      }
      plies = state.history.length - idx;
    }
    res.json(store.takeback(plies, "human"));
  });

  router.post("/resign", (req, res) => {
    const body = (req.body ?? {}) as Partial<ResignRequest>;
    const color = humanSeatColor(store, body.color);
    if (!color) {
      sendError(res, 400, "Nenhum assento humano para desistir (informe `color` se ocupar os dois).");
      return;
    }
    res.json(store.endGame("resignation", color));
  });

  router.post("/draw", (req, res) => {
    const body = (req.body ?? {}) as { color?: unknown };
    const color = humanSeatColor(store, body.color);
    if (!color) {
      sendError(res, 400, "Nenhum assento humano para oferecer empate.");
      return;
    }
    const { accepted, state } = store.offerDraw(color);
    res.json({ ...state, drawAccepted: accepted });
  });

  router.post("/highlight/clear", (_req, res) => {
    res.json(store.setHighlight("system", null));
  });

  router.get("/pgn", (_req, res) => {
    const state = store.getState();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="partida-${state.id}.pgn"`);
    res.send(`${state.pgn.trim()}\n`);
  });

  router.get("/games", (_req, res) => {
    res.json(deps.persistence.listGames());
  });

  router.get("/games/:id/pgn", (req, res) => {
    const id = String(req.params.id ?? "");
    const pgn = deps.persistence.readGamePgn(id);
    if (pgn === null) {
      sendError(res, 404, "Partida não encontrada.");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.pgn"`);
    res.send(pgn);
  });

  router.use((_req, res) => {
    sendError(res, 404, "Rota não encontrada.");
  });

  // Tratador de erros: GameError → 4xx com legalMoves; resto → 500.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GameError) {
      sendError(res, statusForError(err), err.message, err.legalMoves);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`erro inesperado: ${message}`);
    if (!res.headersSent) sendError(res, 500, "Erro interno do servidor.");
  });

  return router;
}
