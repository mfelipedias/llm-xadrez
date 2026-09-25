/**
 * CONTRATO COMPARTILHADO entre servidor, frontend e ferramentas MCP.
 * Qualquer mudança aqui deve ser refletida em docs/02-contrato-mcp.md e docs/03-servidor.md.
 */

export type Color = "white" | "black";
/**
 * Quem ocupa um assento:
 *  - "human": navegador (REST /api/move)
 *  - "mcp":   sessão MCP externa (tools via /mcp)
 *  - "bot":   BotPlayer interno do servidor, falando com um provedor de LLM (docs/09)
 *  - "empty": livre
 */
export type SeatKind = "human" | "mcp" | "bot" | "empty";

/** Estado do loop de um assento `bot` (docs/09, seção 5.1). */
export type BotStatus = "idle" | "waiting" | "thinking" | "acting" | "error" | "budget_exceeded" | "stopped";

export interface BotUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimatedCostUsd?: number;
  illegalMoves: number;
}

/**
 * Raciocínio do modelo: `default` deixa como o provedor/modelo vier; `off` pede resposta
 * direta, sem a fase de "pensar" (modelos locais podem levar minutos pensando num lance).
 */
export type ThinkingMode = "default" | "off";

/** Informação exibida/persistida de um assento `bot`. Nunca contém chaves de API. */
export interface BotSeatInfo {
  /** Id do provedor em providers.json, ex.: "openrouter". */
  providerId: string;
  /** Modelo, ex.: "anthropic/claude-sonnet-4.6". */
  model: string;
  profileId?: string;
  toolMode: "native" | "text";
  /** Ausente = `default`. */
  thinking?: ThinkingMode;
  status: BotStatus;
  /** Texto curto para a UI: "chave inválida", "429: aguardando 4 s"... */
  statusText?: string;
  /** ISO; a UI conta o tempo de "pensando…" a partir daqui. */
  thinkingSince?: string;
  usage: BotUsage;
}

export interface Seat {
  kind: SeatKind;
  /** Nome exibido: "Felipe", "Claude Desktop", "Claude Code"... */
  name: string;
  /** Para kind "mcp" (sessão Streamable HTTP) e "bot" (sessão sintética do servidor). */
  sessionId?: string;
  /** ISO. Só para mcp/bot. */
  connectedAt?: string;
  /** ISO. Última chamada de tool desta sessão (para a UI mostrar "pensando"/"ociosa"). */
  lastSeenAt?: string;
  /** Só para kind === "bot". */
  bot?: BotSeatInfo;
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
  /** Quem executou: humano (navegador), sessão MCP ou bot interno. */
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
  /**
   * Mensagens do humano desta partida (entregues ou não — ver `deliveredTo`), no máximo as
   * 100 mais recentes. A UI mostra todas no feed; a LLM só recebe as ainda não entregues a ela.
   */
  humanMessages: HumanMessage[];
  highlight: Highlight | null;

  drawOffer?: { by: Color; at: string } | null;
}

/* ---------- WebSocket (servidor → navegador) ---------- */

export interface ServerInfo {
  version: string;
  mcpUrl: string; // ex.: http://localhost:3939/mcp
  /** Só sessões MCP externas: sessões sintéticas de bots não entram aqui. */
  mcpSessions: {
    sessionId: string;
    name?: string;
    seat?: Color;
    lastSeenAt?: string;
    /** true enquanto a sessão está bloqueada em wait_for_turn (UI: "aguardando"). */
    waiting?: boolean;
    /**
     * true se a sessão fez uma requisição recentemente (ou está em wait_for_turn).
     * Sessões sem atividade há muito tempo são fechadas pelo servidor; até lá, `false`.
     */
    active?: boolean;
  }[];
  /**
   * Autenticação exigida em /mcp: "none" ou "token" (MCP_TOKEN definido — aceito como
   * `Authorization: Bearer <token>` ou `?token=<token>` na URL). O token NUNCA vem aqui.
   */
  mcpAuth?: "none" | "token";
  /** Como o servidor está rodando: muda os snippets de conexão e as dicas de rede. */
  runtime?: "docker" | "node";
  /** Provedores configurados (sem chaves). Ausente se a camada de provedores não está ativa. */
  providers?: ProviderPublic[];
  /** Perfis de bot disponíveis (docs/09, seção 4.2). */
  profiles?: BotProfile[];
  /** Status dos assentos `bot` da partida atual. */
  bots?: Record<Color, BotSeatInfo | null>;
}

export type WsServerMessage =
  | { type: "hello"; state: GameState; server: ServerInfo }
  | { type: "state"; state: GameState }
  | { type: "server"; server: ServerInfo }
  /** Mudança de status/uso de um bot, sem reenviar o estado inteiro. */
  | { type: "bot"; color: Color; bot: BotSeatInfo };

/* ---------- REST (navegador → servidor) ---------- */

export type HumanSeating = "white" | "black" | "both" | "none";

export type BotRole = "teacher" | "opponent" | "silent";
export type StudentLevel = "beginner" | "intermediate" | "advanced";

/** Pedido de ocupação de um assento em `POST /api/game` (docs/09, seção 5.1). */
export type SeatRequest =
  | { kind: "human"; name?: string }
  /** Assento fica vazio, aguardando `join_game` de uma sessão MCP. */
  | { kind: "mcp"; name?: string }
  | { kind: "empty"; name?: string }
  | {
      kind: "bot";
      profileId?: string;
      providerId?: string;
      model?: string;
      name?: string;
      role?: BotRole;
      level?: StudentLevel;
      /** Sobrescreve o `thinking` do perfil. */
      thinking?: ThinkingMode;
    };

export interface NewGameRequest {
  /** Quais assentos o humano ocupa. "none" = assistir LLM vs LLM. Legado: `seats` tem precedência. */
  humanSeats?: HumanSeating;
  humanName?: string;
  startFen?: string;
  /** Novo (docs/09): controle explícito de cada assento. Tem precedência sobre `humanSeats`. */
  seats?: { white: SeatRequest; black: SeatRequest };
}

/* ---------- Provedores de LLM e perfis de bot (docs/09) ---------- */

export type ProviderKind = "openai" | "anthropic";
export type ToolMode = "native" | "text" | "auto";

/** Visão pública de um provedor: NUNCA contém a chave de API. */
export interface ProviderPublic {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Nome da variável de ambiente que guarda a chave, ex.: "OPENROUTER_API_KEY". */
  apiKeyEnv?: string;
  hasApiKey: boolean;
  /** Ex.: "sk-or-…a1b2". Só os últimos caracteres. */
  apiKeyMasked?: string;
  toolMode: ToolMode;
  local: boolean;
  paid: boolean;
  lastTest?: { ok: boolean; at: string; latencyMs?: number; error?: string; models?: number };
  /** Timeout de uma chamada ao modelo, em ms. */
  timeoutMs?: number;
  /** Id do preset de origem, quando o provedor foi criado a partir de um (informativo). */
  preset?: string;
}

/** Resposta de GET /api/providers. */
export interface ProvidersResponse {
  providers: ProviderPublic[];
  profiles: BotProfile[];
  presets: string[];
  /**
   * NOMES (nunca valores) das variáveis de ambiente com cara de chave (`*_API_KEY`,
   * `*_KEY`, `*_TOKEN`) definidas e não vazias no servidor — exceto MCP_TOKEN/ADMIN_TOKEN.
   * A UI usa para sugerir o `apiKeyEnv` de um provedor novo.
   */
  envKeys?: string[];
  /** false quando quem pediu não pode gravar (não é localhost/rede confiável e não mandou o token). */
  canAdmin?: boolean;
  /** true se um token de administração é aceito (ADMIN_TOKEN ou MCP_TOKEN definido). */
  adminTokenAccepted?: boolean;
}

/** Corpo de PUT /api/providers/:id (cria ou atualiza). `null` ou "" limpa um campo opcional. */
export interface ProviderUpsert {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  toolMode?: ToolMode;
  local?: boolean;
  paid?: boolean;
  timeoutMs?: number | null;
}

/** Resultado de POST /api/providers/:id/test. */
export type ProviderTestResponse =
  | { ok: true; latencyMs: number; models?: number }
  | { ok: false; error: string; /** Dica acionável em pt-BR (rede do Docker, OLLAMA_HOST…). */ hint?: string };

export interface BotLimits {
  maxTokensPerGame?: number;
  maxUsdPerGame?: number;
  maxIterationsPerTurn?: number;
}

export interface BotProfile {
  id: string;
  name: string;
  providerId: string;
  model: string;
  role: BotRole;
  level: StudentLevel;
  temperature?: number;
  toolMode?: "native" | "text";
  historyTurns?: number;
  /** Ausente = `default`. */
  thinking?: ThinkingMode;
  limits?: BotLimits;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  supportsTools?: boolean;
  pricing?: { prompt?: number; completion?: number };
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
  /**
   * Código estável para a UI reagir. "admin_forbidden": rota de administração recusada;
   * se `adminTokenAccepted`, a UI pode pedir o token e reenviar com `Authorization: Bearer`.
   */
  code?: "admin_forbidden";
  adminTokenAccepted?: boolean;
  /** Dica acionável em pt-BR (ex.: erro de rede ao listar modelos de um provedor). */
  hint?: string;
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
