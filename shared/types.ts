/**
 * CONTRATO COMPARTILHADO entre servidor, frontend e ferramentas MCP.
 * Qualquer mudança aqui deve ser refletida em docs/02-contrato-mcp.md e docs/03-servidor.md.
 */

export type Color = "white" | "black";
export type SeatKind = "human" | "mcp" | "empty";

export interface Seat {
  kind: SeatKind;
  /** Nome exibido: "Felipe", "Claude Desktop", "Claude Code"... */
  name: string;
  /** Só para kind === "mcp": id da sessão Streamable HTTP que ocupa o assento. */
  sessionId?: string;
  /** ISO. Só para mcp. */
  connectedAt?: string;
  /** ISO. Última chamada de tool desta sessão (para a UI mostrar "pensando"/"ociosa"). */
  lastSeenAt?: string;
}

export type GameStatus = "waiting" | "active" | "finished";
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";
export type EndReason =
  | "checkmate"
  | "stalemate"
  | "insufficient_material"
  | "threefold_repetition"
  | "fifty_move_rule"
  | "resignation"
  | "draw_agreed"
  | "aborted";

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type PieceColor = "w" | "b";

export interface PieceOnSquare {
  square: string; // "e4"
  type: PieceType;
  color: PieceColor;
}

export interface LegalMove {
  san: string; // "Nf3", "exd5", "O-O", "e8=Q+"
  uci: string; // "g1f3", "e7e8q"
  from: string;
  to: string;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  isCapture: boolean;
  isCheck: boolean;
  isCastle: boolean;
}

export interface MoveRecord {
  ply: number; // 1 = primeiro lance das brancas
  moveNumber: number; // 1, 1, 2, 2, ...
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  isCheck: boolean;
  isCheckmate: boolean;
  fenAfter: string;
  /** Quem executou: humano (navegador) ou sessão MCP. */
  by: SeatKind;
  /** Comentário enviado junto com o lance (make_move.comment). */
  comment?: string;
  timestamp: string; // ISO
}

export type CommentCategory =
  | "lesson" // explicação didática
  | "plan" // plano / ideia estratégica
  | "reaction" // reação ao lance do oponente
  | "question" // pergunta ao aluno
  | "praise" // elogio
  | "warning" // alerta de erro / ameaça
  | "info"; // sistema

export interface Commentary {
  id: string;
  /** Ply em que o comentário foi feito (posição a que se refere). */
  ply: number;
  author: Color | "system";
  authorName: string;
  category: CommentCategory;
  text: string;
  /** Destaque opcional anexado ao comentário (setas/casas). */
  highlight?: HighlightSpec;
  timestamp: string;
}

export interface HighlightSquare {
  square: string;
  /** CSS color; default definido pela UI. */
  color?: string;
}
export interface HighlightArrow {
  from: string;
  to: string;
  color?: string;
}
export interface HighlightSpec {
  squares: HighlightSquare[];
  arrows: HighlightArrow[];
}
export interface Highlight extends HighlightSpec {
  by: Color | "system";
  /** Ply em que foi criado; a UI limpa automaticamente quando o ply muda. */
  ply: number;
}

export type MessageTarget = Color | "all";

export interface HumanMessage {
  id: string;
  ply: number;
  text: string;
  to: MessageTarget;
  /** Assentos MCP que já receberam a mensagem numa resposta de tool. */
  deliveredTo: Color[];
  timestamp: string;
}

export interface CapturedPieces {
  /** Peças pretas capturadas pelas brancas (letras minúsculas: "p","n"...). */
  byWhite: PieceType[];
  /** Peças brancas capturadas pelas pretas. */
  byBlack: PieceType[];
}

export interface GameState {
  id: string;
  createdAt: string;
  updatedAt: string;

  status: GameStatus;
  result: GameResult;
  endReason?: EndReason;
  /** Cor que venceu (ou undefined em empate / em andamento). */
  winner?: Color;

  seats: Record<Color, Seat>;

  /** FEN da posição inicial (padrão ou de set_position/start_fen). */
  startFen: string;
  fen: string;
  turn: Color;
  /** Número de meios-lances já jogados. */
  ply: number;
  /** Número do lance completo em curso (1 no início). */
  moveNumber: number;

  inCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;

  lastMove?: MoveRecord;
  history: MoveRecord[];
  pgn: string;

  /** Lances legais para `turn`. Vazio se a partida terminou. */
  legalMoves: LegalMove[];
  pieces: PieceOnSquare[];
  /** Tabuleiro ASCII (brancas embaixo), como chess.js `ascii()`. */
  ascii: string;
  captured: CapturedPieces;
  /** Material em peões: >0 brancas na frente, <0 pretas. Q=9 R=5 B=3 N=3 P=1. */
  materialBalance: number;

  commentary: Commentary[];
  /** Mensagens do humano ainda não entregues a pelo menos um destinatário. */
  humanMessages: HumanMessage[];
  highlight: Highlight | null;

  drawOffer?: { by: Color; at: string } | null;
}

/* ---------- WebSocket (servidor → navegador) ---------- */

export interface ServerInfo {
  version: string;
  mcpUrl: string; // ex.: http://localhost:3939/mcp
  mcpSessions: {
    sessionId: string;
    name?: string;
    seat?: Color;
    lastSeenAt?: string;
    /** true enquanto a sessão está bloqueada em wait_for_turn (UI: "aguardando"). */
    waiting?: boolean;
  }[];
}

export type WsServerMessage =
  | { type: "hello"; state: GameState; server: ServerInfo }
  | { type: "state"; state: GameState }
  | { type: "server"; server: ServerInfo };

/* ---------- REST (navegador → servidor) ---------- */

export type HumanSeating = "white" | "black" | "both" | "none";

export interface NewGameRequest {
  /** Quais assentos o humano ocupa. "none" = assistir LLM vs LLM. */
  humanSeats: HumanSeating;
  humanName?: string;
  startFen?: string;
}

export interface MoveRequest {
  /** SAN ("Nf3") ou UCI ("g1f3", "e7e8q"). */
  move: string;
}

export interface MessageRequest {
  text: string;
  to: MessageTarget;
}

export interface TakebackRequest {
  /** Meios-lances a desfazer. Default: até a última vez que o humano jogou. */
  plies?: number;
}

export interface ResignRequest {
  /** Necessário se o humano ocupa os dois assentos. */
  color?: Color;
}

export interface ApiError {
  error: string;
  /** Presente em lance ilegal. */
  legalMoves?: string[];
}

/* ---------- Eventos entregues a quem espera em wait_for_turn ---------- */

export type TurnEventType =
  | "your_turn" // é sua vez (oponente já sentado). Inclui opponentMove se houve.
  | "opponent_moved" // oponente jogou; é sua vez
  | "message" // humano mandou mensagem (pode ou não ser sua vez)
  | "takeback" // lances foram desfeitos
  | "opponent_joined" // o outro assento foi ocupado
  | "new_game" // uma nova partida foi criada pelo humano
  | "game_over" // partida terminou
  | "timeout" // nada aconteceu no prazo: chame de novo
  | "not_seated"; // você não ocupa nenhum assento: chame new_game/join_game

export interface TurnEvent {
  event: TurnEventType;
  yourColor?: Color;
  isYourTurn: boolean;
  opponentMove?: MoveRecord;
  messages: HumanMessage[];
  waitedSeconds: number;
  /** Instrução curta para a LLM: "Chame make_move" / "Chame wait_for_turn" etc. */
  nextAction: string;
}
