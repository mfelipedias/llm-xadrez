/**
 * GameStore: única fonte de verdade da partida atual.
 * Mantém o GameState (shared/types.ts) sincronizado com uma instância Chess (chess.js),
 * os assentos, as filas de eventos por assento (wait_for_turn) e o registro de sessões MCP.
 *
 * Eventos emitidos (EventEmitter):
 *  - "change"  (state: GameState)               → qualquer mutação do estado da partida
 *  - "server"                                   → sessões MCP abertas/fechadas, lastSeenAt
 *  - "archive" ({ id, pgn, state })             → partida terminada/substituída com ≥ 2 lances
 *
 * Ver docs/03-servidor.md.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { Chess, DEFAULT_POSITION, validateFen, type Move } from "chess.js";
import type {
  CapturedPieces,
  Color,
  CommentCategory,
  Commentary,
  EndReason,
  GameResult,
  GameState,
  GameStatus,
  Highlight,
  HighlightSpec,
  HumanMessage,
  MessageTarget,
  MoveRecord,
  Seat,
  SeatKind,
  ServerInfo,
  TurnEvent,
  TurnEventType,
} from "../../../shared/types.js";
import {
  captured as capturedPieces,
  endState,
  fromChessColor,
  legalMoves,
  materialBalance,
  otherColor,
  parseMove,
  pieces as piecesOnBoard,
  toChessColor,
  type EndState,
} from "./rules.js";

/* ------------------------------------------------------------------ */
/* Tipos públicos                                                      */
/* ------------------------------------------------------------------ */

export type GameErrorCode =
  | "not_seated"
  | "not_your_turn"
  | "game_not_active"
  | "game_finished"
  | "illegal_move"
  | "seat_taken"
  | "no_free_seat"
  | "invalid_argument"
  | "invalid_fen"
  | "nothing_to_undo";

/** Erro de regra: capturado pelas tools/API e transformado em resposta amigável. */
export class GameError extends Error {
  constructor(
    public readonly code: GameErrorCode,
    message: string,
    public readonly legalMoves?: string[],
  ) {
    super(message);
    this.name = "GameError";
  }
}

export interface SeatInit {
  kind: SeatKind;
  name?: string;
  sessionId?: string;
}

export interface NewGameOptions {
  seats: { white: SeatInit; black: SeatInit };
  startFen?: string;
  /** Sessão MCP que criou a partida (não recebe evento `new_game`). */
  bySessionId?: string;
}

export interface JoinOptions {
  sessionId: string;
  color?: Color;
  name?: string;
  force?: boolean;
}

export interface ApplyMoveOptions {
  comment?: string;
  commentCategory?: CommentCategory;
}

export interface WaitOptions {
  signal?: AbortSignal;
  sessionId?: string;
}

export interface GameStoreOptions {
  defaultHumanName?: string;
  defaultLlmName?: string;
  /** Tempo sem atividade após o qual um assento MCP pode ser retomado por outra sessão. */
  sessionIdleMs?: number;
  /** Relógio injetável (testes). */
  now?: () => number;
}

export interface ArchiveEvent {
  id: string;
  pgn: string;
  state: GameState;
}

/* ------------------------------------------------------------------ */
/* Internos                                                            */
/* ------------------------------------------------------------------ */

interface QueuedEvent {
  type: TurnEventType;
  opponentMove?: MoveRecord;
}

interface Waiter {
  color: Color;
  sessionId?: string;
  startedAt: number;
  resolve: (event: TurnEvent) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

interface SessionInfo {
  openedAt: string;
  closed: boolean;
}

const EVENT_PRIORITY: Record<TurnEventType, number> = {
  game_over: 9,
  opponent_moved: 8,
  your_turn: 7,
  takeback: 6,
  new_game: 5,
  opponent_joined: 4,
  message: 3,
  timeout: 1,
  not_seated: 0,
};

/** Motivos de fim decididos pelo tabuleiro (podem ser desfeitos com takeback). */
const BOARD_END_REASONS: ReadonlySet<EndReason> = new Set([
  "checkmate",
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
]);

const MAX_COMMENTARY = 500;
const MAX_MESSAGES = 100;

function makeId(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function pgnDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function cloneHighlightSpec(spec: HighlightSpec | undefined | null): HighlightSpec {
  return {
    squares: (spec?.squares ?? []).map((s) => (s.color ? { square: s.square, color: s.color } : { square: s.square })),
    arrows: (spec?.arrows ?? []).map((a) => (a.color ? { from: a.from, to: a.to, color: a.color } : { from: a.from, to: a.to })),
  };
}

/* ------------------------------------------------------------------ */
/* GameStore                                                           */
/* ------------------------------------------------------------------ */

export class GameStore extends EventEmitter {
  private readonly defaultHumanName: string;
  private readonly defaultLlmName: string;
  private readonly sessionIdleMs: number;
  private readonly now: () => number;

  private chess = new Chess();
  private id = "";
  private createdAt = "";
  private updatedAt = "";
  private seats: Record<Color, Seat> = {
    white: { kind: "empty", name: "" },
    black: { kind: "empty", name: "" },
  };
  private startFen = DEFAULT_POSITION;
  private history: MoveRecord[] = [];
  private commentary: Commentary[] = [];
  private humanMessages: HumanMessage[] = [];
  private highlight: Highlight | null = null;
  private drawOffer: { by: Color; at: string } | null = null;
  private endReason: EndReason | undefined;
  private result: GameResult = "*";
  private winner: Color | undefined;
  private archived = false;

  private queues: Record<Color, QueuedEvent[]> = { white: [], black: [] };
  private waiters: Waiter[] = [];
  private sessions = new Map<string, SessionInfo>();
  private stateCache: GameState | null = null;

  constructor(opts: GameStoreOptions = {}) {
    super();
    this.defaultHumanName = opts.defaultHumanName ?? "Você";
    this.defaultLlmName = opts.defaultLlmName ?? "Claude";
    this.sessionIdleMs = opts.sessionIdleMs ?? 120_000;
    this.now = opts.now ?? (() => Date.now());
    this.resetGame(DEFAULT_POSITION, {
      white: { kind: "human", name: this.defaultHumanName },
      black: { kind: "empty" },
    });
  }

  /* ---------------------------- utilidades ---------------------------- */

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private makeSeat(init: SeatInit): Seat {
    if (init.kind === "empty") return { kind: "empty", name: init.name ?? "" };
    if (init.kind === "human") return { kind: "human", name: init.name?.trim() || this.defaultHumanName };
    const iso = this.nowIso();
    const seat: Seat = { kind: "mcp", name: init.name?.trim() || this.defaultLlmName, connectedAt: iso, lastSeenAt: iso };
    if (init.sessionId) seat.sessionId = init.sessionId;
    return seat;
  }

  private setHeaders(): void {
    this.chess.setHeader("Event", "LLM Xadrez");
    this.chess.setHeader("Site", "localhost");
    this.chess.setHeader("Date", pgnDate(this.now()));
    this.chess.setHeader("Round", "-");
    this.chess.setHeader("White", this.seats.white.name || "?");
    this.chess.setHeader("Black", this.seats.black.name || "?");
    this.chess.setHeader("Result", this.result);
  }

  private touch(): void {
    this.updatedAt = this.nowIso();
    this.stateCache = null;
    this.emit("change", this.getState());
  }

  private resetGame(startFen: string, seats: { white: SeatInit; black: SeatInit }): void {
    this.chess = new Chess(startFen);
    this.id = makeId(this.now());
    this.createdAt = this.nowIso();
    this.updatedAt = this.createdAt;
    this.startFen = startFen;
    this.seats = { white: this.makeSeat(seats.white), black: this.makeSeat(seats.black) };
    this.history = [];
    this.commentary = [];
    this.humanMessages = [];
    this.highlight = null;
    this.drawOffer = null;
    this.endReason = undefined;
    this.result = "*";
    this.winner = undefined;
    this.archived = false;
    this.queues = { white: [], black: [] };
    this.stateCache = null;
    this.setHeaders();
  }

  private computeStatus(): GameStatus {
    if (this.endReason) return "finished";
    if (this.seats.white.kind === "empty" || this.seats.black.kind === "empty") return "waiting";
    return "active";
  }

  get status(): GameStatus {
    return this.computeStatus();
  }

  get turn(): Color {
    return fromChessColor(this.chess.turn());
  }

  get currentId(): string {
    return this.id;
  }

  isYourTurn(color: Color): boolean {
    return this.computeStatus() === "active" && this.turn === color;
  }

  /* ------------------------------ estado ------------------------------ */

  getState(): GameState {
    if (this.stateCache) return this.stateCache;
    const verboseHistory = this.chess.history({ verbose: true }) as Move[];
    const pieces = piecesOnBoard(this.chess);
    const status = this.computeStatus();
    const capturedNow: CapturedPieces = capturedPieces(verboseHistory);
    const lastMove = this.history[this.history.length - 1];
    const state: GameState = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      status,
      result: this.result,
      seats: { white: { ...this.seats.white }, black: { ...this.seats.black } },
      startFen: this.startFen,
      fen: this.chess.fen(),
      turn: this.turn,
      ply: this.history.length,
      moveNumber: this.chess.moveNumber(),
      inCheck: this.chess.inCheck(),
      isCheckmate: this.chess.isCheckmate(),
      isStalemate: this.chess.isStalemate(),
      isDraw: this.chess.isDraw() || this.endReason === "draw_agreed",
      history: this.history.map((m) => ({ ...m })),
      pgn: this.chess.pgn(),
      legalMoves: this.endReason ? [] : legalMoves(this.chess),
      pieces,
      ascii: this.chess.ascii(),
      captured: capturedNow,
      materialBalance: materialBalance(pieces),
      commentary: this.commentary.map((c) => ({ ...c })),
      humanMessages: this.humanMessages.map((m) => ({ ...m, deliveredTo: [...m.deliveredTo] })),
      highlight: this.highlight ? { ...this.highlight, ...cloneHighlightSpec(this.highlight) } : null,
      drawOffer: this.drawOffer ? { ...this.drawOffer } : null,
    };
    if (this.endReason) state.endReason = this.endReason;
    if (this.winner) state.winner = this.winner;
    if (lastMove) state.lastMove = { ...lastMove };
    this.stateCache = state;
    return state;
  }

  getPgn(): string {
    return this.chess.pgn();
  }

  serverInfo(version: string, mcpUrl: string): ServerInfo {
    const mcpSessions: ServerInfo["mcpSessions"] = [];
    for (const [sessionId, info] of this.sessions) {
      if (info.closed) continue;
      const seatColor = this.seatForSession(sessionId);
      const entry: ServerInfo["mcpSessions"][number] = { sessionId };
      if (seatColor) {
        entry.seat = seatColor;
        entry.name = this.seats[seatColor].name;
        if (this.seats[seatColor].lastSeenAt) entry.lastSeenAt = this.seats[seatColor].lastSeenAt;
      }
      if (this.waiters.some((w) => w.sessionId === sessionId)) entry.waiting = true;
      mcpSessions.push(entry);
    }
    return { version, mcpUrl, mcpSessions };
  }

  /* --------------------------- sessões MCP ---------------------------- */

  sessionOpened(sessionId: string): void {
    this.sessions.set(sessionId, { openedAt: this.nowIso(), closed: false });
    this.emit("server");
  }

  sessionClosed(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) info.closed = true;
    // Quem estava esperando nessa sessão não vai receber a resposta: libera o timer.
    this.cancelWaiters((w) => w.sessionId === sessionId, "timeout");
    this.emit("server");
  }

  isSessionOpen(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const info = this.sessions.get(sessionId);
    return !!info && !info.closed;
  }

  /** Sessão morta ou ociosa há mais de `sessionIdleMs`: o assento pode ser retomado. */
  private isSessionGone(seat: Seat): boolean {
    if (seat.kind !== "mcp") return false;
    if (!seat.sessionId) return true;
    const info = this.sessions.get(seat.sessionId);
    if (!info || info.closed) return true;
    const last = seat.lastSeenAt ? Date.parse(seat.lastSeenAt) : 0;
    return this.now() - last > this.sessionIdleMs;
  }

  /** Atualiza `lastSeenAt` do assento ocupado pela sessão (toda chamada de tool). */
  touchSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    const color = this.seatForSession(sessionId);
    if (!color) return;
    this.seats[color].lastSeenAt = this.nowIso();
    this.stateCache = null;
    this.emit("server");
  }

  seatForSession(sessionId: string | undefined): Color | null {
    if (!sessionId) return null;
    for (const color of ["white", "black"] as Color[]) {
      const seat = this.seats[color];
      if (seat.kind === "mcp" && seat.sessionId === sessionId) return color;
    }
    return null;
  }

  /* ------------------------------ partida ----------------------------- */

  newGame(opts: NewGameOptions): GameState {
    const startFen = opts.startFen?.trim() || DEFAULT_POSITION;
    const check = validateFen(startFen);
    if (!check.ok) throw new GameError("invalid_fen", `FEN inválido: ${check.error ?? "formato incorreto"}.`);

    this.archiveCurrent();
    const previousSeats = this.seats;
    this.resetGame(startFen, opts.seats);

    // Quem perdeu o assento é acordado como `not_seated`; quem continua sentado muda de cor se preciso
    // e recebe `new_game`.
    this.cancelWaiters((w) => !w.sessionId || !this.seatForSession(w.sessionId), "not_seated");
    for (const w of this.waiters) {
      const c = this.seatForSession(w.sessionId);
      if (c) w.color = c;
    }
    for (const color of ["white", "black"] as Color[]) {
      const seat = this.seats[color];
      if (seat.kind !== "mcp" || !seat.sessionId) continue;
      const wasSeated =
        previousSeats.white.sessionId === seat.sessionId || previousSeats.black.sessionId === seat.sessionId;
      if (wasSeated && seat.sessionId !== opts.bySessionId) this.pushEvent(color, "new_game");
    }
    this.touch();
    return this.getState();
  }

  private archiveCurrent(): void {
    if (this.archived || this.history.length < 2) return;
    this.archived = true;
    this.setHeaders();
    const payload: ArchiveEvent = { id: this.id, pgn: this.chess.pgn(), state: this.getState() };
    this.emit("archive", payload);
  }

  seat(color: Color, init: SeatInit): GameState {
    this.seats[color] = this.makeSeat(init);
    this.setHeaders();
    this.touch();
    return this.getState();
  }

  unseat(color: Color): GameState {
    const seat = this.seats[color];
    if (seat.kind === "mcp" && seat.sessionId) {
      const sid = seat.sessionId;
      this.cancelWaiters((w) => w.sessionId === sid || w.color === color, "not_seated");
    }
    // Mantém o nome no assento vazio (como em restoreSeat): a UI ainda mostra "X venceu" e o PGN
    // conserva o header White/Black depois de um leave_game pós-partida.
    this.seats[color] = { kind: "empty", name: seat.name };
    this.queues[color] = [];
    this.setHeaders();
    this.touch();
    return this.getState();
  }

  /** Implementa as regras de `join_game` (docs/02). Devolve a cor ocupada. */
  joinGame(opts: JoinOptions): Color {
    const name = opts.name?.trim() || this.defaultLlmName;
    const already = this.seatForSession(opts.sessionId);
    if (already && (!opts.color || opts.color === already)) {
      // Já sentado: só atualiza o nome.
      this.seats[already].name = name;
      this.seats[already].lastSeenAt = this.nowIso();
      this.setHeaders();
      this.touch();
      return already;
    }

    let target = opts.color;
    if (!target) {
      const free = (["white", "black"] as Color[]).filter((c) => this.isSeatFree(c));
      if (free.length === 1) target = free[0];
      else if (free.length === 0) {
        throw new GameError("no_free_seat", "Nenhum assento livre. Use force: true para tomar um, ou new_game para começar outra partida.");
      } else {
        throw new GameError("invalid_argument", "Os dois assentos estão livres: informe color ('white' ou 'black').");
      }
    }

    const seat = this.seats[target];
    const colorPt = target === "white" ? "brancas" : "pretas";
    if (seat.kind === "human" && !opts.force) {
      throw new GameError(
        "seat_taken",
        `O assento das ${colorPt} é do humano (${seat.name}). Use force: true para tomá-lo (o humano vira espectador) ou entre na outra cor.`,
      );
    }
    if (seat.kind === "mcp" && !opts.force && !this.isSessionGone(seat) && seat.name !== name) {
      throw new GameError(
        "seat_taken",
        `O assento das ${colorPt} está ocupado por outra LLM ativa (${seat.name}). Use force: true para tomá-lo.`,
      );
    }

    // Sessão anterior (se houver) perde o assento.
    if (seat.kind === "mcp" && seat.sessionId && seat.sessionId !== opts.sessionId) {
      const old = seat.sessionId;
      this.cancelWaiters((w) => w.sessionId === old, "not_seated");
    }
    if (already && already !== target) {
      // Troca de cor: libera o assento antigo.
      this.seats[already] = { kind: "empty", name: "" };
      this.queues[already] = [];
    }

    this.seats[target] = this.makeSeat({ kind: "mcp", name, sessionId: opts.sessionId });
    this.queues[target] = [];
    this.setHeaders();
    const opp = otherColor(target);
    if (this.seats[opp].kind === "mcp") this.pushEvent(opp, "opponent_joined");
    this.touch();
    return target;
  }

  private isSeatFree(color: Color): boolean {
    const seat = this.seats[color];
    return seat.kind === "empty" || (seat.kind === "mcp" && this.isSessionGone(seat));
  }

  /* ------------------------------- lances ----------------------------- */

  legalSans(): string[] {
    return this.chess.moves();
  }

  applyMove(color: Color, move: string, opts: ApplyMoveOptions = {}): MoveRecord {
    if (this.endReason) throw new GameError("game_finished", "A partida já terminou. Chame new_game para começar outra.");
    const status = this.computeStatus();
    if (status !== "active") {
      const empty = (["white", "black"] as Color[]).find((c) => this.seats[c].kind === "empty");
      const emptyPt = empty === "white" ? "das brancas" : "das pretas";
      throw new GameError(
        "game_not_active",
        this.history.length === 0
          ? `A partida ainda não começou: o assento ${emptyPt} está vazio. Aguarde o oponente (wait_for_turn).`
          : `A partida está pausada: o assento ${emptyPt} ficou vazio (o oponente saiu). Aguarde alguém sentar (wait_for_turn).`,
      );
    }
    if (this.turn !== color) {
      const turnPt = this.turn === "white" ? "brancas" : "pretas";
      throw new GameError("not_your_turn", `Não é sua vez: é a vez das ${turnPt}. Chame wait_for_turn.`);
    }
    const parsed = parseMove(this.chess, move);
    if (!parsed) {
      throw new GameError("illegal_move", `Lance ilegal: "${move}".`, this.chess.moves());
    }
    const applied = this.chess.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
    const comment = opts.comment?.trim();
    if (comment) this.chess.setComment(comment);

    const record: MoveRecord = {
      ply: this.history.length + 1,
      moveNumber: this.moveNumberOf(applied.before),
      color,
      san: applied.san,
      uci: `${applied.from}${applied.to}${applied.promotion ?? ""}`,
      from: applied.from,
      to: applied.to,
      piece: applied.piece,
      isCheck: this.chess.inCheck(),
      isCheckmate: this.chess.isCheckmate(),
      fenAfter: this.chess.fen(),
      by: this.seats[color].kind === "empty" ? "human" : this.seats[color].kind,
      timestamp: this.nowIso(),
    };
    if (applied.captured) record.captured = applied.captured;
    if (applied.promotion) record.promotion = applied.promotion;
    if (comment) record.comment = comment;
    this.history.push(record);
    this.drawOffer = null;

    const end = endState(this.chess);
    if (end) this.finish(end);

    // Eventos antigos do próprio jogador (ex.: opponent_moved já consumido ao jogar) ficam obsoletos.
    this.clearEvents(color, ["opponent_moved", "your_turn", "takeback"]);
    const opp = otherColor(color);
    if (end) this.pushEvent(opp, "game_over", record);
    else this.pushEvent(opp, "opponent_moved", record);
    this.touch();
    return record;
  }

  private moveNumberOf(fenBefore: string): number {
    const parts = fenBefore.split(" ");
    const n = Number(parts[5]);
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  takeback(plies: number, by: Color | "human" | "system"): GameState {
    if (this.endReason && !BOARD_END_REASONS.has(this.endReason)) {
      throw new GameError("game_finished", "A partida foi encerrada (desistência/empate/abortada); não dá para desfazer lances.");
    }
    if (!Number.isInteger(plies) || plies < 1) throw new GameError("invalid_argument", "plies deve ser um inteiro ≥ 1.");
    if (this.history.length === 0) throw new GameError("nothing_to_undo", "Não há lances para desfazer.");
    const n = Math.min(plies, this.history.length);
    for (let i = 0; i < n; i++) {
      this.chess.undo();
      this.history.pop();
    }
    this.endReason = undefined;
    this.result = "*";
    this.winner = undefined;
    this.archived = false;
    this.highlight = null;
    this.drawOffer = null;
    this.setHeaders();
    for (const color of ["white", "black"] as Color[]) {
      this.clearEvents(color, ["opponent_moved", "your_turn", "game_over"]);
    }
    for (const color of ["white", "black"] as Color[]) {
      if (color === by) continue;
      if (this.seats[color].kind === "mcp") this.pushEvent(color, "takeback");
    }
    this.touch();
    return this.getState();
  }

  /* ------------------------- comentários/destaques -------------------- */

  addComment(author: Color | "system", text: string, category: CommentCategory, highlight?: HighlightSpec | null): Commentary {
    const authorName = author === "system" ? "Sistema" : this.seats[author].name || author;
    const entry: Commentary = {
      id: shortId(),
      ply: this.history.length,
      author,
      authorName,
      category,
      text: text.trim(),
      timestamp: this.nowIso(),
    };
    if (highlight && (highlight.squares?.length || highlight.arrows?.length)) {
      entry.highlight = cloneHighlightSpec(highlight);
      this.highlight = { ...cloneHighlightSpec(highlight), by: author, ply: this.history.length };
    }
    this.commentary.push(entry);
    if (this.commentary.length > MAX_COMMENTARY) this.commentary.splice(0, this.commentary.length - MAX_COMMENTARY);
    this.touch();
    return entry;
  }

  setHighlight(by: Color | "system", spec: HighlightSpec | null): GameState {
    if (!spec || (!spec.squares?.length && !spec.arrows?.length)) this.highlight = null;
    else this.highlight = { ...cloneHighlightSpec(spec), by, ply: this.history.length };
    this.touch();
    return this.getState();
  }

  /* ------------------------------ mensagens --------------------------- */

  addHumanMessage(text: string, to: MessageTarget): HumanMessage {
    const msg: HumanMessage = {
      id: shortId(),
      ply: this.history.length,
      text: text.trim(),
      to,
      deliveredTo: [],
      timestamp: this.nowIso(),
    };
    this.humanMessages.push(msg);
    if (this.humanMessages.length > MAX_MESSAGES) this.humanMessages.splice(0, this.humanMessages.length - MAX_MESSAGES);
    for (const color of ["white", "black"] as Color[]) {
      if (to !== "all" && to !== color) continue;
      if (this.seats[color].kind === "mcp") this.pushEvent(color, "message");
    }
    this.touch();
    return msg;
  }

  pendingMessages(color: Color): HumanMessage[] {
    return this.humanMessages.filter((m) => (m.to === "all" || m.to === color) && !m.deliveredTo.includes(color));
  }

  /** Marca as mensagens pendentes de `color` como entregues e remove eventos `message` da fila. */
  markDelivered(color: Color): HumanMessage[] {
    const pending = this.pendingMessages(color);
    for (const m of pending) m.deliveredTo.push(color);
    this.clearEvents(color, ["message"]);
    if (pending.length) this.touch();
    return pending.map((m) => ({ ...m, deliveredTo: [...m.deliveredTo] }));
  }

  /* ------------------------------ fim de jogo ------------------------- */

  private finish(end: EndState): void {
    this.endReason = end.endReason;
    this.result = end.result;
    this.winner = end.winner;
    this.drawOffer = null;
    this.setHeaders();
    this.archiveCurrent();
  }

  endGame(reason: "resignation" | "draw_agreed" | "aborted", by?: Color): GameState {
    if (this.endReason) throw new GameError("game_finished", "A partida já terminou.");
    if (reason === "resignation") {
      if (!by) throw new GameError("invalid_argument", "Desistência exige a cor de quem desiste.");
      const winner = otherColor(by);
      this.finish({ endReason: "resignation", result: winner === "white" ? "1-0" : "0-1", winner });
    } else if (reason === "draw_agreed") {
      this.finish({ endReason: "draw_agreed", result: "1/2-1/2" });
    } else {
      this.finish({ endReason: "aborted", result: "*" });
    }
    for (const color of ["white", "black"] as Color[]) {
      this.clearEvents(color, ["opponent_moved", "your_turn"]);
      if (color === by) continue;
      if (this.seats[color].kind === "mcp") this.pushEvent(color, "game_over");
    }
    this.touch();
    return this.getState();
  }

  /**
   * Oferta de empate pelo humano (v1): se já existe oferta do oponente, aceita (empate imediato);
   * senão registra `drawOffer` e avisa a LLM por mensagem (ela aceita com end_game(draw)).
   */
  offerDraw(by: Color): { accepted: boolean; state: GameState } {
    if (this.endReason) throw new GameError("game_finished", "A partida já terminou.");
    if (this.drawOffer && this.drawOffer.by !== by) {
      return { accepted: true, state: this.endGame("draw_agreed", by) };
    }
    this.drawOffer = { by, at: this.nowIso() };
    const byName = this.seats[by].name || by;
    this.addComment("system", `${byName} oferece empate.`, "info");
    const opp = otherColor(by);
    if (this.seats[opp].kind === "mcp") {
      this.addHumanMessage('Ofereço empate. Para aceitar, chame end_game(how: "draw"); para recusar, apenas continue jogando.', opp);
    }
    this.touch();
    return { accepted: false, state: this.getState() };
  }

  /* --------------------------- eventos/waiters ------------------------ */

  private pushEvent(color: Color, type: TurnEventType, opponentMove?: MoveRecord): void {
    const ev: QueuedEvent = { type };
    if (opponentMove) ev.opponentMove = opponentMove;
    this.queues[color].push(ev);
    this.wake(color);
  }

  private clearEvents(color: Color, types: TurnEventType[]): void {
    this.queues[color] = this.queues[color].filter((e) => !types.includes(e.type));
  }

  private wake(color: Color): void {
    const waiter = this.waiters.find((w) => w.color === color);
    if (!waiter) return;
    const event = this.drain(color, waiter.startedAt);
    if (!event) return;
    this.removeWaiter(waiter);
    waiter.resolve(event);
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
    waiter.cleanup();
  }

  private cancelWaiters(pred: (w: Waiter) => boolean, type: "timeout" | "not_seated"): void {
    const targets = this.waiters.filter(pred);
    for (const w of targets) {
      this.removeWaiter(w);
      w.resolve(this.buildEvent(type, w.color, w.startedAt, []));
    }
    if (targets.length) this.emit("server");
  }

  nextAction(color: Color | null): string {
    if (!color) return "Você não ocupa nenhum assento. Chame new_game ou join_game.";
    const status = this.computeStatus();
    if (status === "finished") return "Partida encerrada. Comente o resultado com o aluno ou chame new_game para outra partida.";
    if (status === "waiting") return "Aguardando o oponente sentar. Chame wait_for_turn.";
    if (this.turn === color) return "É sua vez: chame make_move com um dos lances legais.";
    return "Não é sua vez. Chame wait_for_turn.";
  }

  private buildEvent(type: TurnEventType, color: Color, startedAt: number, messages: HumanMessage[], opponentMove?: MoveRecord): TurnEvent {
    const isYourTurn = this.isYourTurn(color);
    const ev: TurnEvent = {
      event: type,
      yourColor: color,
      isYourTurn,
      messages,
      waitedSeconds: Math.max(0, Math.round((this.now() - startedAt) / 100) / 10),
      nextAction: type === "not_seated" ? this.nextAction(null) : this.nextAction(color),
    };
    if (type === "message" && !isYourTurn && this.computeStatus() === "active") {
      ev.nextAction = "Responda ao aluno (no chat e/ou com comment) e chame wait_for_turn de novo.";
    }
    if (opponentMove) ev.opponentMove = { ...opponentMove };
    return ev;
  }

  private eventStillValid(e: QueuedEvent, color: Color): boolean {
    switch (e.type) {
      case "opponent_moved":
      case "your_turn":
        return this.isYourTurn(color);
      case "game_over":
        return !!this.endReason;
      case "message":
        return this.pendingMessages(color).length > 0;
      default:
        return true;
    }
  }

  /** Drena a fila de `color`; devolve o evento mais importante ou `null` se não há nada. */
  private drain(color: Color, startedAt: number): TurnEvent | null {
    const events = this.queues[color].filter((e) => this.eventStillValid(e, color));
    this.queues[color] = [];
    const myTurn = this.isYourTurn(color);
    if (myTurn && !events.some((e) => e.type === "opponent_moved" || e.type === "game_over")) {
      const last = this.history[this.history.length - 1];
      const ev: QueuedEvent = { type: "your_turn" };
      if (last && last.color !== color) ev.opponentMove = last;
      events.push(ev);
    }
    const messages = this.pendingMessages(color);
    if (messages.length && !events.some((e) => e.type === "message")) events.push({ type: "message" });
    if (events.length === 0) return null;
    events.sort((a, b) => EVENT_PRIORITY[b.type] - EVENT_PRIORITY[a.type]);
    const top = events[0];
    const delivered = this.markDelivered(color);
    const opponentMove = top.opponentMove ?? events.find((e) => e.opponentMove)?.opponentMove;
    return this.buildEvent(top.type, color, startedAt, delivered, opponentMove);
  }

  /**
   * Espera algo relevante para `color` (sem bloquear o event loop) ou até `timeoutMs`.
   * Resolve imediatamente se já há evento na fila ou se é a vez do chamador.
   */
  waitForTurn(color: Color, timeoutMs: number, opts: WaitOptions = {}): Promise<TurnEvent> {
    const startedAt = this.now();
    const immediate = this.drain(color, startedAt);
    if (immediate) return Promise.resolve(immediate);
    if (opts.signal?.aborted) return Promise.resolve(this.buildEvent("timeout", color, startedAt, []));

    return new Promise<TurnEvent>((resolve) => {
      const onAbort = (): void => {
        this.removeWaiter(waiter);
        resolve(this.buildEvent("timeout", color, startedAt, []));
        this.emit("server");
      };
      const waiter: Waiter = {
        color,
        sessionId: opts.sessionId,
        startedAt,
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          resolve(this.buildEvent("timeout", color, startedAt, []));
          this.emit("server");
        }, Math.max(0, timeoutMs)),
        cleanup: () => {
          clearTimeout(waiter.timer);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.emit("server");
    });
  }

  get waiterCount(): number {
    return this.waiters.length;
  }

  /** Cancela todos os waiters (shutdown). */
  dispose(): void {
    this.cancelWaiters(() => true, "timeout");
  }

  /* ----------------------------- persistência ------------------------- */

  /** Restaura uma partida salva. Assentos MCP viram `empty` (as sessões morreram). */
  loadState(saved: GameState): void {
    const chess = new Chess(saved.startFen || DEFAULT_POSITION);
    const history: MoveRecord[] = [];
    for (const rec of saved.history ?? []) {
      const mv = chess.move(rec.san);
      if (rec.comment) chess.setComment(rec.comment);
      history.push({ ...rec, fenAfter: mv.after });
    }
    this.chess = chess;
    this.id = saved.id || makeId(this.now());
    this.createdAt = saved.createdAt || this.nowIso();
    this.updatedAt = saved.updatedAt || this.createdAt;
    this.startFen = saved.startFen || DEFAULT_POSITION;
    this.history = history;
    this.commentary = (saved.commentary ?? []).map((c) => ({ ...c }));
    this.humanMessages = (saved.humanMessages ?? []).map((m) => ({ ...m, deliveredTo: [...(m.deliveredTo ?? [])] }));
    this.highlight = saved.highlight ? { ...saved.highlight, ...cloneHighlightSpec(saved.highlight) } : null;
    this.drawOffer = saved.drawOffer ? { ...saved.drawOffer } : null;
    this.endReason = saved.endReason;
    this.result = saved.result ?? "*";
    this.winner = saved.winner;
    this.archived = !!saved.endReason;
    this.seats = {
      white: this.restoreSeat(saved.seats?.white),
      black: this.restoreSeat(saved.seats?.black),
    };
    // Coerência: se o tabuleiro diz que acabou mas o arquivo não, recalcula.
    if (!this.endReason) {
      const end = endState(this.chess);
      if (end) {
        this.endReason = end.endReason;
        this.result = end.result;
        this.winner = end.winner;
        this.archived = true;
      }
    }
    this.queues = { white: [], black: [] };
    this.setHeaders();
    this.stateCache = null;
    this.emit("change", this.getState());
  }

  private restoreSeat(seat: Seat | undefined): Seat {
    if (!seat) return { kind: "empty", name: "" };
    if (seat.kind === "human") return { kind: "human", name: seat.name || this.defaultHumanName };
    if (seat.kind === "mcp") return { kind: "empty", name: seat.name || "" };
    return { kind: "empty", name: seat.name || "" };
  }
}

export { toChessColor };
