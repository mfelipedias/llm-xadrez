/**
 * Fixtures de desenvolvimento, usados quando a URL tem `?mock=<cenário>`
 * (docs/10 §7, item 5). Servem para ajustar CSS e gerar as capturas de tela de
 * cada fase sem precisar do servidor:
 *
 *   ?mock=1          partida de meio-jogo, humano (brancas) vs IA (pretas)
 *   ?mock=waiting    aguardando a IA conectar (assento preto livre)
 *   ?mock=llmvsllm   modo espectador: duas IAs jogando
 *   ?mock=finished   partida encerrada por xeque-mate
 *   ?mock=empty      nenhuma partida começou, os dois assentos livres
 *   ?mock=bots       humano (brancas) vs bot do servidor (pretas), pensando (docs/09 §4.3)
 *   ?mock=botsvsbots dois bots do servidor jogando: espectador com balões duplos (docs/10 §3.5)
 *   ?mock=docker     servidor em Docker com MCP_TOKEN: pretas aguardando MCP, uma sessão velha
 *                    (inativa) que não conta como "cliente registrado"
 *
 * Todos os cenários respondem às rotas `/api/providers*` através de `mockRequest`,
 * para a tela "Provedores" poder ser vista sem servidor. A gravação (PUT, preset,
 * DELETE) mexe só numa cópia em memória, que some ao recarregar a página.
 *
 * `&admin=token` simula um navegador de outro computador com `ADMIN_TOKEN` no servidor:
 * as rotas de administração respondem 403 `admin_forbidden` até um token ser digitado
 * (qualquer valor serve). `&admin=none` simula o mesmo sem token aceito.
 */
import { Chess } from "chess.js";
import type {
  BotProfile,
  BotSeatInfo,
  BotStatus,
  CapturedPieces,
  Color,
  Commentary,
  EndReason,
  GameResult,
  GameState,
  GameStatus,
  HumanMessage,
  LegalMove,
  MoveRecord,
  PieceOnSquare,
  ModelInfo,
  PieceType,
  ProviderPublic,
  Seat,
  ServerInfo,
} from "@shared/types";

export type MockScenario =
  | "default"
  | "waiting"
  | "llmvsllm"
  | "finished"
  | "empty"
  | "bots"
  | "botsvsbots"
  | "docker";

const HUMAN_NAME = "Felipe";
const AI_NAME = "Claude";
const SESSION_ID = "sess-claude-1";

const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const startedAt = Date.now() - 22 * 60_000;
const plyTimestamp = (ply: number): string => new Date(startedAt + ply * 55_000).toISOString();
const between = (ply: number, seconds: number): string =>
  new Date(startedAt + ply * 55_000 + seconds * 1000).toISOString();

interface GameConfig {
  id: string;
  sanLine: string[];
  seats: Record<Color, Seat>;
  moveComments?: Record<number, string>;
  commentary?: Commentary[];
  humanMessages?: HumanMessage[];
  highlight?: GameState["highlight"];
  status: GameStatus;
  result?: GameResult;
  endReason?: EndReason;
  winner?: Color;
}

function buildState(cfg: GameConfig): GameState {
  const chess = new Chess();
  const startFen = chess.fen();
  const history: MoveRecord[] = [];

  cfg.sanLine.forEach((san, index) => {
    const ply = index + 1;
    const move = chess.move(san);
    const color: Color = move.color === "w" ? "white" : "black";
    history.push({
      ply,
      moveNumber: Math.ceil(ply / 2),
      color,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      from: move.from,
      to: move.to,
      piece: move.piece,
      captured: move.captured,
      promotion: move.promotion,
      isCheck: move.san.endsWith("+") || move.san.endsWith("#"),
      isCheckmate: move.san.endsWith("#"),
      fenAfter: move.after,
      by: cfg.seats[color].kind,
      comment: cfg.moveComments?.[ply],
      timestamp: plyTimestamp(ply),
    });
  });

  const legalMoves: LegalMove[] = chess.moves({ verbose: true }).map((m) => ({
    san: m.san,
    uci: `${m.from}${m.to}${m.promotion ?? ""}`,
    from: m.from,
    to: m.to,
    piece: m.piece,
    captured: m.captured,
    promotion: m.promotion,
    isCapture: m.isCapture(),
    isCheck: m.san.endsWith("+") || m.san.endsWith("#"),
    isCastle: m.isKingsideCastle() || m.isQueensideCastle(),
  }));

  const pieces: PieceOnSquare[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) pieces.push({ square: cell.square, type: cell.type, color: cell.color });
    }
  }

  const captured: CapturedPieces = { byWhite: [], byBlack: [] };
  for (const record of history) {
    if (!record.captured) continue;
    if (record.color === "white") captured.byWhite.push(record.captured);
    else captured.byBlack.push(record.captured);
  }

  const materialBalance = pieces.reduce(
    (sum, p) => sum + (p.color === "w" ? 1 : -1) * PIECE_VALUES[p.type],
    0,
  );

  const ply = history.length;

  return {
    id: cfg.id,
    createdAt: plyTimestamp(0),
    updatedAt: plyTimestamp(ply + 1),
    status: cfg.status,
    result: cfg.result ?? "*",
    endReason: cfg.endReason,
    winner: cfg.winner,
    seats: cfg.seats,
    startFen,
    fen: chess.fen(),
    turn: chess.turn() === "w" ? "white" : "black",
    ply,
    moveNumber: chess.moveNumber(),
    inCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    lastMove: history[history.length - 1],
    history,
    pgn: chess.pgn(),
    legalMoves: cfg.status === "finished" ? [] : legalMoves,
    pieces,
    ascii: chess.ascii(),
    captured,
    materialBalance,
    commentary: cfg.commentary ?? [],
    humanMessages: cfg.humanMessages ?? [],
    highlight: cfg.highlight ?? null,
    drawOffer: null,
  };
}

/* ---------------- cenário padrão: Ataque Möller, meio-jogo ---------------- */

const SAN_LINE = [
  "e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4", "cxd4", "Bb4+",
  "Nc3", "Nxe4", "O-O", "Bxc3", "d5", "Bf6", "Re1", "Ne7", "Rxe4", "d6",
];

/** Comentários enviados junto com o lance (make_move.comment), por ply. */
const MOVE_COMMENTS: Record<number, string> = {
  6: "Desenvolvo o bispo para a diagonal **a7–g1**, apontando para f2 — o ponto mais sensível do seu futuro roque.",
  12: "Xeque! Ganho um *tempo*: você precisa responder ao xeque antes de continuar o desenvolvimento.",
  14: "Aceito o peão. É a linha principal do *Ataque Möller* — arriscada, mas muito instrutiva.",
  16: "Troco o bispo pelo cavalo e fico com um peão a mais. Repare que `bxc3` deixaria sua estrutura de peões danificada.",
  18: "Recuo o bispo para uma casa segura: `d5` ameaçava meu cavalo em c6.",
  20: "O cavalo estava atacado pelo peão de d5; e7 é a única casa boa para ele.",
  22: "Abro a diagonal do bispo de c8 e consolido. Sua vez: procure um lance que **desenvolva com ameaça**.",
};

const DEFAULT_COMMENTARY: Commentary[] = [
  {
    id: "c-sys-0",
    ply: 0,
    author: "system",
    authorName: "Sistema",
    category: "info",
    text: `Nova partida: ${HUMAN_NAME} (brancas) vs ${AI_NAME} (pretas).`,
    timestamp: plyTimestamp(0),
  },
  {
    id: "c-1",
    ply: 4,
    author: "black",
    authorName: AI_NAME,
    category: "lesson",
    text:
      "**Abertura Italiana.** Os dois lados desenvolvem cavalos e bispos rumo ao centro. Objetivos nesta fase:\n" +
      "- controlar as casas e4 e d4\n" +
      "- desenvolver as peças menores antes da dama\n" +
      "- rocar cedo para proteger o rei",
    highlight: {
      squares: [
        { square: "e4", color: "green" },
        { square: "d4", color: "green" },
      ],
      arrows: [],
    },
    timestamp: between(4, 20),
  },
  {
    id: "c-2",
    ply: 9,
    author: "black",
    authorName: AI_NAME,
    category: "praise",
    text: "Ótimo! `5.d4` é o lance mais ambicioso: você ataca o centro *antes* de eu terminar o desenvolvimento.",
    timestamp: between(9, 15),
  },
  {
    id: "c-3",
    ply: 15,
    author: "black",
    authorName: AI_NAME,
    category: "reaction",
    text: "Você rocou em vez de recapturar em c3 — boa escolha: `9.bxc3` era possível, mas um rei seguro vale mais do que um peão agora.",
    timestamp: between(15, 12),
  },
  {
    id: "c-4",
    ply: 15,
    author: "black",
    authorName: AI_NAME,
    category: "lesson",
    text: "Respondendo à sua pergunta: depois de `7...Nxd4 8.Nxd4` eu ficaria com o bispo de b4 atacado *e* sem o peão de e4. Prefiro capturar em e4, que é o peão central — vale mais do que o de d4 nesta estrutura.",
    timestamp: between(15, 40),
  },
  {
    id: "c-5",
    ply: 21,
    author: "black",
    authorName: AI_NAME,
    category: "question",
    text: "Você recuperou o peão com `11.Rxe4`. Pergunta: qual peça branca ainda **não** entrou no jogo, e para onde você a levaria?",
    timestamp: between(21, 18),
  },
  {
    id: "c-6",
    ply: 22,
    author: "black",
    authorName: AI_NAME,
    category: "warning",
    text: "Atenção: meu bispo de f6 e o cavalo de e7 vigiam d5. Se você mover a torre de e4 sem cuidado, o peão de d5 pode cair.",
    highlight: {
      squares: [{ square: "d5", color: "yellow" }],
      arrows: [
        { from: "f6", to: "d4", color: "blue" },
        { from: "e7", to: "d5", color: "blue" },
      ],
    },
    timestamp: between(22, 25),
  },
];

const DEFAULT_MESSAGES: HumanMessage[] = [
  {
    id: "hm-1",
    ply: 15,
    text: "por que você não tomou o peão de d4 com o cavalo no lance 7?",
    to: "black",
    deliveredTo: ["black"],
    timestamp: between(15, 30),
  },
  {
    id: "hm-2",
    ply: 22,
    text: "qual seria um bom plano para mim agora? pode dar uma dica sem entregar o lance",
    to: "all",
    deliveredTo: [],
    timestamp: between(22, 40),
  },
];

const humanSeat = (): Seat => ({ kind: "human", name: HUMAN_NAME });
const mcpSeat = (name: string, sessionId: string): Seat => ({
  kind: "mcp",
  name,
  sessionId,
  connectedAt: plyTimestamp(0),
  lastSeenAt: new Date(Date.now() - 1200).toISOString(),
});
const emptySeat = (): Seat => ({ kind: "empty", name: "" });

function mcpSession(sessionId: string, name: string, seat: Color | undefined, waiting: boolean, active = true) {
  return {
    sessionId,
    name,
    seat,
    lastSeenAt: new Date(Date.now() - (active ? 1200 : 22 * 60_000)).toISOString(),
    waiting,
    active,
  };
}

const serverBase: Pick<ServerInfo, "version" | "mcpUrl" | "mcpAuth" | "runtime"> = {
  version: "0.1.0-mock",
  mcpUrl: "http://localhost:3939/mcp",
  mcpAuth: "none",
  runtime: "node",
};

/* ---------------------------- cenários ---------------------------- */

function defaultScenario(): { state: GameState; server: ServerInfo } {
  return {
    state: buildState({
      id: "3f2a9c",
      sanLine: SAN_LINE,
      seats: { white: humanSeat(), black: mcpSeat(AI_NAME, SESSION_ID) },
      moveComments: MOVE_COMMENTS,
      commentary: DEFAULT_COMMENTARY,
      humanMessages: DEFAULT_MESSAGES,
      status: "active",
      highlight: {
        by: "black",
        ply: SAN_LINE.length,
        squares: [
          { square: "f7", color: "red" },
          { square: "d5", color: "yellow" },
          { square: "e4", color: "green" },
        ],
        arrows: [
          { from: "c4", to: "f7", color: "red" },
          { from: "e4", to: "e7" },
          { from: "f6", to: "d4", color: "blue" },
        ],
      },
    }),
    server: { ...serverBase, mcpSessions: [mcpSession(SESSION_ID, AI_NAME, "black", true)] },
  };
}

function waitingScenario(): { state: GameState; server: ServerInfo } {
  return {
    state: buildState({
      id: "waiting",
      sanLine: [],
      seats: { white: humanSeat(), black: emptySeat() },
      status: "waiting",
      commentary: [
        {
          id: "c-w-0",
          ply: 0,
          author: "system",
          authorName: "Sistema",
          category: "info",
          text: `Nova partida: ${HUMAN_NAME} (brancas). Aguardando uma IA nas pretas.`,
          timestamp: plyTimestamp(0),
        },
      ],
    }),
    server: { ...serverBase, mcpSessions: [] },
  };
}

function llmVsLlmScenario(): { state: GameState; server: ServerInfo } {
  const line = ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "e3", "O-O", "Bd3", "d5", "Nf3", "c5"];
  const white = mcpSeat("Claude Desktop", "sess-desktop");
  const black = mcpSeat("Claude Code", "sess-code");
  return {
    state: buildState({
      id: "llmvsllm",
      sanLine: line,
      seats: { white, black },
      moveComments: {
        6: "Nimzo-Índia. Prendo o cavalo de c3 e brigo pelo controle de e4.",
        11: "Desenvolvo com o plano de Rubinstein: peças primeiro, tensão central depois.",
      },
      commentary: [
        {
          id: "c-l-0",
          ply: 0,
          author: "system",
          authorName: "Sistema",
          category: "info",
          text: "Partida entre duas IAs. Você está assistindo — pode perguntar às duas pelo campo de mensagem.",
          timestamp: plyTimestamp(0),
        },
        {
          id: "c-l-1",
          ply: 6,
          author: "black",
          authorName: "Claude Code",
          category: "plan",
          text: "Meu plano nas pretas: **trocar o bispo pelo cavalo de c3** e atacar os peões dobrados que sobram.",
          highlight: { squares: [{ square: "c3", color: "red" }], arrows: [{ from: "b4", to: "c3", color: "red" }] },
          timestamp: between(6, 10),
        },
        {
          id: "c-l-2",
          ply: 9,
          author: "white",
          authorName: "Claude Desktop",
          category: "lesson",
          text: "Aceito a estrutura: os peões dobrados custam caro, mas o **par de bispos** paga a conta em posições abertas.",
          timestamp: between(9, 14),
        },
        {
          id: "c-l-3",
          ply: 12,
          author: "black",
          authorName: "Claude Code",
          category: "reaction",
          text: "`c5` ataca a base do centro branco. A partir daqui a partida vira uma briga de estruturas.",
          highlight: { squares: [{ square: "d4", color: "yellow" }], arrows: [{ from: "c5", to: "d4", color: "green" }] },
          timestamp: between(12, 9),
        },
      ],
      humanMessages: [
        {
          id: "hm-l-1",
          ply: 10,
          text: "vocês duas podem explicar o que estão tentando fazer?",
          to: "all",
          deliveredTo: ["white", "black"],
          timestamp: between(10, 5),
        },
      ],
      status: "active",
      highlight: {
        by: "black",
        ply: line.length,
        squares: [{ square: "d4", color: "yellow" }],
        arrows: [{ from: "c5", to: "d4", color: "green" }],
      },
    }),
    server: {
      ...serverBase,
      mcpSessions: [
        mcpSession("sess-desktop", "Claude Desktop", "white", false),
        mcpSession("sess-code", "Claude Code", "black", true),
      ],
    },
  };
}

function finishedScenario(): { state: GameState; server: ServerInfo } {
  const line = ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"];
  return {
    state: buildState({
      id: "finished",
      sanLine: line,
      seats: { white: humanSeat(), black: mcpSeat(AI_NAME, SESSION_ID) },
      moveComments: {
        6: "Cuidado — esse cavalo não defende f7. Olhe para a dama e o bispo brancos.",
      },
      commentary: [
        {
          id: "c-f-1",
          ply: 5,
          author: "black",
          authorName: AI_NAME,
          category: "warning",
          text: "`3.Qh5` é o **mate do pastor**: a dama e o bispo miram f7 ao mesmo tempo. Eu vou cair de propósito para você ver o padrão.",
          highlight: {
            squares: [{ square: "f7", color: "red" }],
            arrows: [
              { from: "h5", to: "f7", color: "red" },
              { from: "c4", to: "f7", color: "red" },
            ],
          },
          timestamp: between(5, 8),
        },
        {
          id: "c-f-2",
          ply: 7,
          author: "black",
          authorName: AI_NAME,
          category: "lesson",
          text: "Xeque-mate. O rei não pode tomar a dama (o bispo de c4 a defende) nem fugir. **f7 e f2 são as casas mais fracas do início** porque só o rei as defende.",
          timestamp: between(7, 6),
        },
      ],
      status: "finished",
      result: "1-0",
      endReason: "checkmate",
      winner: "white",
    }),
    server: { ...serverBase, mcpSessions: [mcpSession(SESSION_ID, AI_NAME, "black", true)] },
  };
}

function emptyScenario(): { state: GameState; server: ServerInfo } {
  return {
    state: buildState({
      id: "empty",
      sanLine: [],
      seats: { white: emptySeat(), black: emptySeat() },
      status: "waiting",
    }),
    server: { ...serverBase, mcpSessions: [] },
  };
}

/**
 * Servidor em Docker com `MCP_TOKEN`: o humano está de brancas, as pretas esperam
 * uma sessão MCP e a única sessão conhecida está inativa há 22 min — o passo 2 do
 * onboarding não pode contá-la como "cliente registrado".
 */
function dockerScenario(): { state: GameState; server: ServerInfo } {
  const base = waitingScenario();
  return {
    state: { ...base.state, id: "docker" },
    server: {
      ...serverBase,
      runtime: "docker",
      mcpAuth: "token",
      mcpSessions: [mcpSession("sess-velha", "Claude Code", undefined, false, false)],
      providers: MOCK_PROVIDERS,
      profiles: MOCK_PROFILES,
      bots: { white: null, black: null },
    },
  };
}

/* ------------- cenários com bots do servidor (docs/09 §4.3) ------------- */

interface BotSeatOptions {
  providerId: string;
  model: string;
  profileId?: string;
  status?: BotStatus;
  statusText?: string;
  thinkingSeconds?: number;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  illegalMoves?: number;
}

function botSeat(name: string, opts: BotSeatOptions): Seat {
  const bot: BotSeatInfo = {
    providerId: opts.providerId,
    model: opts.model,
    toolMode: "native",
    status: opts.status ?? "waiting",
    usage: {
      calls: opts.calls ?? 11,
      inputTokens: opts.inputTokens ?? 9400,
      outputTokens: opts.outputTokens ?? 2600,
      illegalMoves: opts.illegalMoves ?? 0,
      ...(opts.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: opts.estimatedCostUsd }),
    },
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    ...(opts.statusText ? { statusText: opts.statusText } : {}),
    ...(opts.thinkingSeconds === undefined
      ? {}
      : { thinkingSince: new Date(Date.now() - opts.thinkingSeconds * 1000).toISOString() }),
  };
  return {
    kind: "bot",
    name,
    sessionId: `bot-${opts.providerId}-${name}`,
    connectedAt: plyTimestamp(0),
    lastSeenAt: new Date(Date.now() - 800).toISOString(),
    bot,
  };
}

export const MOCK_PROVIDERS: ProviderPublic[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    hasApiKey: true,
    apiKeyMasked: "sk-or-…a1b2",
    toolMode: "native",
    local: false,
    paid: true,
    lastTest: { ok: true, at: new Date(Date.now() - 60_000).toISOString(), latencyMs: 248, models: 143 },
  },
  {
    id: "anthropic",
    name: "Anthropic (API direta)",
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    hasApiKey: false,
    toolMode: "native",
    local: false,
    paid: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    hasApiKey: false,
    toolMode: "auto",
    local: true,
    paid: false,
    lastTest: {
      ok: false,
      at: new Date(Date.now() - 120_000).toISOString(),
      error: "conexão recusada em localhost:1234",
    },
  },
  {
    id: "fake",
    name: "Fake (determinístico)",
    kind: "openai",
    hasApiKey: false,
    toolMode: "native",
    local: true,
    paid: false,
    lastTest: { ok: true, at: new Date(Date.now() - 20_000).toISOString(), latencyMs: 2, models: 1 },
  },
];

export const MOCK_PROFILES: BotProfile[] = [
  {
    id: "professora-sonnet",
    name: "Professora (Claude Sonnet via OpenRouter)",
    providerId: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    role: "teacher",
    level: "beginner",
    temperature: 0.7,
    limits: { maxUsdPerGame: 1.0, maxTokensPerGame: 400_000 },
  },
  {
    id: "local-qwen",
    name: "Adversário local (Qwen3 8B)",
    providerId: "lmstudio",
    model: "qwen3-8b",
    role: "opponent",
    level: "beginner",
    toolMode: "text",
  },
  {
    id: "fake-1",
    name: "Bot determinístico (testes)",
    providerId: "fake",
    model: "fake-1",
    role: "opponent",
    level: "beginner",
  },
];

const MOCK_MODELS: Record<string, ModelInfo[]> = {
  openrouter: [
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      contextLength: 200_000,
      supportsTools: true,
      pricing: { prompt: 0.000003, completion: 0.000015 },
    },
    { id: "openai/gpt-5-mini", name: "GPT-5 mini", contextLength: 400_000, supportsTools: true },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextLength: 1_000_000, supportsTools: true },
    { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", contextLength: 64_000, supportsTools: true },
  ],
  fake: [{ id: "fake-1", name: "Fake 1", contextLength: 8192, supportsTools: true }],
};

const MOCK_PRESETS = ["openrouter", "anthropic", "ollama", "lmstudio", "llamacpp", "vllm", "jan", "litellm", "custom"];

function botsServer(bots: Partial<Record<Color, BotSeatInfo>> = {}): ServerInfo {
  return {
    ...serverBase,
    mcpSessions: [],
    providers: MOCK_PROVIDERS,
    profiles: MOCK_PROFILES,
    bots: { white: bots.white ?? null, black: bots.black ?? null },
  };
}

/** Humano de brancas contra um bot do servidor que está pensando. */
function botsScenario(): { state: GameState; server: ServerInfo } {
  const black = botSeat("Claude Sonnet", {
    providerId: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    profileId: "professora-sonnet",
    status: "thinking",
    thinkingSeconds: 14,
    calls: 12,
    inputTokens: 10_400,
    outputTokens: 2_300,
    estimatedCostUsd: 0.0327,
  });
  return {
    state: buildState({
      id: "bots",
      sanLine: SAN_LINE.slice(0, 21),
      seats: { white: humanSeat(), black },
      moveComments: MOVE_COMMENTS,
      commentary: DEFAULT_COMMENTARY.filter((c) => c.ply <= 21),
      humanMessages: DEFAULT_MESSAGES.filter((m) => m.ply <= 21),
      status: "active",
    }),
    server: botsServer({ black: black.bot }),
  };
}

/** Espectador: dois bots do servidor, cada placa com o seu balão (docs/10 §3.5). */
function botsVsBotsScenario(): { state: GameState; server: ServerInfo } {
  const line = ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "e3", "O-O", "Bd3", "d5", "Nf3", "c5"];
  const white = botSeat("Sonnet (brancas)", {
    providerId: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    profileId: "professora-sonnet",
    status: "thinking",
    thinkingSeconds: 9,
    calls: 7,
    inputTokens: 6100,
    outputTokens: 1800,
    estimatedCostUsd: 0.0206,
  });
  const black = botSeat("Qwen3 (pretas)", {
    providerId: "lmstudio",
    model: "qwen3-8b",
    profileId: "local-qwen",
    status: "waiting",
    calls: 6,
    inputTokens: 5400,
    outputTokens: 2100,
    illegalMoves: 1,
  });
  return {
    state: buildState({
      id: "botsvsbots",
      sanLine: line,
      seats: { white, black },
      moveComments: {
        6: "Nimzo-Índia. Prendo o cavalo de c3 e brigo pelo controle de e4.",
        11: "Desenvolvo com o plano de Rubinstein: peças primeiro, tensão central depois.",
      },
      commentary: [
        {
          id: "c-b-0",
          ply: 0,
          author: "system",
          authorName: "Sistema",
          category: "info",
          text: "Partida entre dois bots do servidor. Você está assistindo — pode perguntar aos dois pelo campo de mensagem.",
          timestamp: plyTimestamp(0),
        },
        {
          id: "c-b-1",
          ply: 9,
          author: "white",
          authorName: "Sonnet (brancas)",
          category: "plan",
          text: "Mantenho o par de bispos e preparo `e4`. Os peões dobrados em c3 são o preço; a diagonal b1–h7 é o lucro.",
          highlight: { squares: [{ square: "e4", color: "green" }], arrows: [{ from: "d3", to: "h7", color: "blue" }] },
          timestamp: between(9, 12),
        },
        {
          id: "c-b-2",
          ply: 12,
          author: "black",
          authorName: "Qwen3 (pretas)",
          category: "reaction",
          text: "`c5` ataca a base do centro branco. A partir daqui a partida vira uma briga de estruturas.",
          highlight: { squares: [{ square: "d4", color: "yellow" }], arrows: [{ from: "c5", to: "d4", color: "green" }] },
          timestamp: between(12, 9),
        },
        {
          id: "c-b-3",
          ply: 12,
          author: "system",
          authorName: "Sistema",
          category: "warning",
          text: "Qwen3 (pretas) devolveu um lance ilegal (`Nd7xe5`) e foi solicitada de novo.",
          timestamp: between(12, 20),
        },
      ],
      humanMessages: [
        {
          id: "hm-b-1",
          ply: 10,
          text: "os dois podem explicar o plano em uma frase?",
          to: "all",
          deliveredTo: ["white", "black"],
          timestamp: between(10, 5),
        },
      ],
      status: "active",
      highlight: {
        by: "black",
        ply: line.length,
        squares: [{ square: "d4", color: "yellow" }],
        arrows: [{ from: "c5", to: "d4", color: "green" }],
      },
    }),
    server: botsServer({ white: white.bot, black: black.bot }),
  };
}

/** Erro HTTP simulado: `api.ts` o converte em `ApiError` como faria com a resposta real. */
export class MockHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Cópia em memória que a gravação em modo mock altera (recarregar a página desfaz). */
let mockProviders: ProviderPublic[] | null = null;
function providersStore(): ProviderPublic[] {
  if (!mockProviders) mockProviders = MOCK_PROVIDERS.map((p) => ({ ...p }));
  return mockProviders;
}

const MOCK_ENV_KEYS = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "MEU_SERVIDOR_API_KEY"];
const MOCK_ENV_MASKS: Record<string, string> = {
  OPENROUTER_API_KEY: "sk-or-…a1b2",
  GROQ_API_KEY: "gsk_…9f3c",
  MEU_SERVIDOR_API_KEY: "…77e1",
};

function mockParams(): { scenario: string; admin: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { scenario: params.get("mock") ?? "", admin: params.get("admin") };
}

/**
 * Mesmas regras de "local" do servidor: loopback, redes privadas e link-local,
 * `.local`/`.lan`/`.internal`/`.home.arpa`, nomes sem ponto (serviço do compose)
 * e host.docker.internal.
 */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "host.docker.internal" ||
      !host.includes(".") ||
      /\.(local|lan|internal|home\.arpa)$/.test(host) ||
      /^169\.254\./.test(host) ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    );
  } catch {
    return false;
  }
}

function mockTest(provider: ProviderPublic, docker: boolean): unknown {
  const models = MOCK_MODELS[provider.id];
  if (models) return { ok: true, latencyMs: 231, models: models.length };
  const url = provider.baseUrl ?? "";
  if (/localhost|127\.0\.0\.1/.test(url)) {
    if (docker) {
      throw new MockHttpError(502, {
        ok: false,
        error: `conexão recusada em ${new URL(url).host}`,
        hint: "O servidor roda em Docker: dentro do container, localhost é o próprio container. Use http://host.docker.internal:<porta>/v1 no endereço.",
      });
    }
    throw new MockHttpError(502, {
      ok: false,
      error: `conexão recusada em ${new URL(url).host}`,
      hint: "O servidor do modelo está no ar? Ollama: rode `ollama serve`. LM Studio: aba Developer → Start Server.",
    });
  }
  if (/host\.docker\.internal/.test(url)) {
    throw new MockHttpError(502, {
      ok: false,
      error: `conexão recusada em ${new URL(url).host}`,
      hint: "O container chegou ao seu computador, mas nada respondeu nessa porta para ele. Ollama escuta só em 127.0.0.1 por padrão: rode com OLLAMA_HOST=0.0.0.0. LM Studio: ligue \"Serve on Local Network\".",
    });
  }
  if (/192\.168\.|\/\/10\./.test(url)) {
    throw new MockHttpError(502, {
      ok: false,
      error: "tempo esgotado (5 s) em " + (url ? new URL(url).host : "?"),
      hint: "Na outra máquina, o servidor do modelo precisa aceitar conexões da rede: Ollama com OLLAMA_HOST=0.0.0.0; LM Studio com \"Serve on Local Network\" ligado. Confira também o firewall.",
    });
  }
  if (provider.apiKeyEnv && !provider.hasApiKey) {
    throw new MockHttpError(502, {
      ok: false,
      error: `sem ${provider.apiKeyEnv} no ambiente do servidor`,
      hint: docker
        ? `Defina ${provider.apiKeyEnv} no .env e recrie o container (docker compose up -d).`
        : `Defina ${provider.apiKeyEnv} no .env e reinicie o servidor.`,
    });
  }
  return { ok: true, latencyMs: 412, models: 12 };
}

/**
 * Respostas de fixture para as rotas de provedores em modo `?mock=`. Leitura
 * devolve os fixtures; gravação altera só a cópia em memória. Nenhuma chave de
 * API existe aqui: os valores mascarados são literais de demonstração.
 */
export function mockRequest(path: string, method: string, body?: string, authorization?: string | null): unknown {
  const route = path.split("?")[0];
  const { scenario, admin } = mockParams();
  const docker = scenario === "docker";
  const authorized = admin === null || (admin === "token" && !!authorization);
  const forbid = () => {
    throw new MockHttpError(403, {
      error:
        admin === "token"
          ? "Esta ação exige o token de administração (ADMIN_TOKEN ou MCP_TOKEN)."
          : "Só é possível alterar provedores a partir do computador do servidor.",
      code: "admin_forbidden",
      adminTokenAccepted: admin === "token",
    });
  };
  const list = providersStore();

  if (route === "/api/providers" && method === "GET") {
    return {
      providers: list,
      profiles: MOCK_PROFILES,
      presets: MOCK_PRESETS,
      envKeys: MOCK_ENV_KEYS,
      canAdmin: authorized,
      adminTokenAccepted: admin !== "none",
    };
  }

  const isAdminRoute = route.startsWith("/api/providers") && (method !== "GET" || /\/models$/.test(route));
  if (isAdminRoute && !authorized) forbid();

  const test = /^\/api\/providers\/([^/]+)\/test$/.exec(route);
  if (test && method === "POST") {
    const provider = list.find((p) => p.id === decodeURIComponent(test[1]));
    if (!provider) throw new MockHttpError(404, { error: "Provedor não encontrado." });
    return mockTest(provider, docker);
  }
  const models = /^\/api\/providers\/([^/]+)\/models$/.exec(route);
  if (models && method === "GET") {
    return MOCK_MODELS[decodeURIComponent(models[1])] ?? [];
  }
  if (route === "/api/providers/preset" && method === "POST") {
    const req = body ? (JSON.parse(body) as { preset?: string; id?: string }) : {};
    const preset = req.preset ?? "custom";
    let id = req.id ?? preset;
    for (let n = 2; list.some((p) => p.id === id); n++) id = `${req.id ?? preset}-${n}`;
    list.push({ id, name: preset, kind: preset === "anthropic" ? "anthropic" : "openai", hasApiKey: false, toolMode: "auto", local: true, paid: false, preset });
    return { id };
  }
  const one = /^\/api\/providers\/([^/]+)$/.exec(route);
  if (one && method === "PUT") {
    const id = decodeURIComponent(one[1]);
    const patch = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const index = list.findIndex((p) => p.id === id);
    const current: ProviderPublic =
      index >= 0 ? list[index] : { id, name: id, kind: "openai", hasApiKey: false, toolMode: "auto", local: false, paid: false };
    const next: ProviderPublic = { ...current };
    if (typeof patch.name === "string") next.name = patch.name;
    if (patch.kind === "openai" || patch.kind === "anthropic") next.kind = patch.kind;
    if (patch.toolMode === "native" || patch.toolMode === "text" || patch.toolMode === "auto") next.toolMode = patch.toolMode;
    if (typeof patch.local === "boolean") next.local = patch.local;
    if (typeof patch.paid === "boolean") next.paid = patch.paid;
    if ("baseUrl" in patch) next.baseUrl = typeof patch.baseUrl === "string" && patch.baseUrl ? patch.baseUrl : undefined;
    if ("timeoutMs" in patch) next.timeoutMs = typeof patch.timeoutMs === "number" ? patch.timeoutMs : undefined;
    if ("apiKeyEnv" in patch) {
      const env = typeof patch.apiKeyEnv === "string" && patch.apiKeyEnv ? patch.apiKeyEnv : undefined;
      next.apiKeyEnv = env;
      next.hasApiKey = !!env && MOCK_ENV_KEYS.includes(env);
      next.apiKeyMasked = env ? MOCK_ENV_MASKS[env] : undefined;
    }
    if (next.baseUrl && isLocalUrl(next.baseUrl) && !("local" in patch)) next.local = true;
    if (index >= 0) list[index] = next;
    else list.push(next);
    return next;
  }
  if (one && method === "DELETE") {
    const id = decodeURIComponent(one[1]);
    mockProviders = list.filter((p) => p.id !== id);
    return { ok: true };
  }
  return null;
}

const SCENARIOS: Record<MockScenario, () => { state: GameState; server: ServerInfo }> = {
  default: defaultScenario,
  waiting: waitingScenario,
  llmvsllm: llmVsLlmScenario,
  finished: finishedScenario,
  empty: emptyScenario,
  bots: botsScenario,
  botsvsbots: botsVsBotsScenario,
  docker: dockerScenario,
};

export function isMockScenario(value: string): value is MockScenario {
  return value in SCENARIOS;
}

/** `?mock=1` cai no cenário padrão; qualquer nome desconhecido também. */
export function mockFixture(name: string): { state: GameState; server: ServerInfo } {
  const key: MockScenario = isMockScenario(name) ? name : "default";
  return SCENARIOS[key]();
}

const fallback = defaultScenario();
export const mockState: GameState = fallback.state;
export const mockServer: ServerInfo = fallback.server;
