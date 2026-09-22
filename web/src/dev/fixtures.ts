/**
 * Fixture de desenvolvimento: uma partida de meio-jogo realista (Ataque Möller,
 * Abertura Italiana) gerada com chess.js para garantir FENs, lances legais e
 * capturas consistentes. Usado quando a URL tem `?mock=1`.
 */
import { Chess } from "chess.js";
import type {
  CapturedPieces,
  Color,
  Commentary,
  GameState,
  HumanMessage,
  LegalMove,
  MoveRecord,
  PieceOnSquare,
  PieceType,
  ServerInfo,
} from "@shared/types";

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

const SESSION_ID = "sess-claude-1";
const HUMAN_NAME = "Felipe";
const AI_NAME = "Claude";

const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const startedAt = Date.now() - 22 * 60_000;
const plyTimestamp = (ply: number): string => new Date(startedAt + ply * 55_000).toISOString();
const between = (ply: number, seconds: number): string =>
  new Date(startedAt + ply * 55_000 + seconds * 1000).toISOString();

function buildState(): GameState {
  const chess = new Chess();
  const startFen = chess.fen();
  const history: MoveRecord[] = [];

  SAN_LINE.forEach((san, index) => {
    const ply = index + 1;
    const move = chess.move(san);
    const color: Color = move.color === "w" ? "white" : "black";
    const record: MoveRecord = {
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
      by: color === "white" ? "human" : "mcp",
      comment: MOVE_COMMENTS[ply],
      timestamp: plyTimestamp(ply),
    };
    history.push(record);
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
  const lastMove = history[history.length - 1];
  const turn: Color = chess.turn() === "w" ? "white" : "black";

  const commentary: Commentary[] = [
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

  const humanMessages: HumanMessage[] = [
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

  return {
    id: "3f2a9c",
    createdAt: plyTimestamp(0),
    updatedAt: between(22, 40),
    status: "active",
    result: "*",
    seats: {
      white: { kind: "human", name: HUMAN_NAME },
      black: {
        kind: "mcp",
        name: AI_NAME,
        sessionId: SESSION_ID,
        connectedAt: plyTimestamp(0),
        lastSeenAt: new Date(Date.now() - 1200).toISOString(),
      },
    },
    startFen,
    fen: chess.fen(),
    turn,
    ply,
    moveNumber: chess.moveNumber(),
    inCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    lastMove,
    history,
    pgn: chess.pgn(),
    legalMoves,
    pieces,
    ascii: chess.ascii(),
    captured,
    materialBalance,
    commentary,
    humanMessages,
    highlight: {
      by: "black",
      ply,
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
    drawOffer: null,
  };
}

export const mockState: GameState = buildState();

export const mockServer: ServerInfo = {
  version: "0.1.0-mock",
  mcpUrl: "http://localhost:3939/mcp",
  mcpSessions: [
    {
      sessionId: SESSION_ID,
      name: AI_NAME,
      seat: "black",
      lastSeenAt: mockState.seats.black.lastSeenAt,
      waiting: true,
    },
  ],
};
