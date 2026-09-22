/**
 * Funções puras sobre chess.js: parse de lances, lances legais, peças, capturas,
 * material e detecção de fim de jogo. Ver docs/03-servidor.md, "Regras".
 */
import { Chess, type Move } from "chess.js";
import type {
  CapturedPieces,
  Color,
  EndReason,
  GameResult,
  LegalMove,
  PieceOnSquare,
  PieceType,
} from "../../../shared/types.js";

export const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Ordem de exibição das peças nas listas. */
export const PIECE_ORDER: PieceType[] = ["k", "q", "r", "b", "n", "p"];

export function otherColor(c: Color): Color {
  return c === "white" ? "black" : "white";
}

export function toChessColor(c: Color): "w" | "b" {
  return c === "white" ? "w" : "b";
}

export function fromChessColor(c: "w" | "b"): Color {
  return c === "w" ? "white" : "black";
}

/** Normaliza a entrada do usuário: `0-0` → `O-O`, remove `+`, `#`, `!`, `?` e espaços. */
export function normalizeMoveInput(input: string): string {
  let s = input.trim().replace(/\s+/g, "");
  if (/^(0-0-0|o-o-o|O-O-O)$/.test(s)) return "O-O-O";
  if (/^(0-0|o-o|O-O)$/.test(s)) return "O-O";
  s = s.replace(/[+#!?]+$/g, "");
  return s;
}

const stripSuffix = (san: string): string => san.replace(/[+#]/g, "");
const loose = (san: string): string => stripSuffix(san).toLowerCase().replace(/[=x]/g, "");

/**
 * Devolve o `Move` (do chess.js, sem aplicar) correspondente à entrada, ou `null`.
 * Aceita SAN ("Nf3", "exd5", "O-O", "e8=Q"), UCI ("g1f3", "e7e8q", "e2-e4"),
 * variações com `+`/`#` supérfluos, `0-0` e diferenças de caixa ("nf3").
 */
export function parseMove(chess: Chess, input: string): Move | null {
  const raw = normalizeMoveInput(input ?? "");
  if (!raw) return null;
  const legal = chess.moves({ verbose: true });

  // 1) UCI: e2e4, e7e8q, e2-e4
  const uci = /^([a-h][1-8])-?([a-h][1-8])=?([qrbn])?$/i.exec(raw);
  if (uci) {
    const from = uci[1].toLowerCase();
    const to = uci[2].toLowerCase();
    const promo = uci[3]?.toLowerCase();
    const found = legal.find(
      (mv) =>
        mv.from === from &&
        mv.to === to &&
        (promo ? mv.promotion === promo : !mv.promotion || mv.promotion === "q"),
    );
    if (found) return found;
  }

  // 2) SAN exato (ignorando +/#)
  const exact = legal.find((mv) => stripSuffix(mv.san) === raw);
  if (exact) return exact;

  // 3) SAN tolerante: caixa, "x" e "=" opcionais. Só aceita se não for ambíguo.
  const target = loose(raw);
  const candidates = legal.filter((mv) => loose(mv.san) === target);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // "bxc3" minúsculo: preferir o lance de peão (coluna b) sobre o bispo.
    const pawn = candidates.filter((mv) => mv.piece === "p");
    if (pawn.length === 1) return pawn[0];
  }
  return null;
}

export function toLegalMove(mv: Move): LegalMove {
  const out: LegalMove = {
    san: mv.san,
    uci: `${mv.from}${mv.to}${mv.promotion ?? ""}`,
    from: mv.from,
    to: mv.to,
    piece: mv.piece,
    isCapture: mv.isCapture() || mv.isEnPassant(),
    isCheck: /[+#]/.test(mv.san),
    isCastle: mv.isKingsideCastle() || mv.isQueensideCastle(),
  };
  if (mv.captured) out.captured = mv.captured;
  if (mv.promotion) out.promotion = mv.promotion;
  return out;
}

export function legalMoves(chess: Chess): LegalMove[] {
  return chess.moves({ verbose: true }).map(toLegalMove);
}

export function pieces(chess: Chess): PieceOnSquare[] {
  const out: PieceOnSquare[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) out.push({ square: cell.square, type: cell.type, color: cell.color });
    }
  }
  return out;
}

/** Peças capturadas a partir do histórico verboso do chess.js. */
export function captured(history: Move[]): CapturedPieces {
  const byWhite: PieceType[] = [];
  const byBlack: PieceType[] = [];
  for (const mv of history) {
    if (!mv.captured) continue;
    if (mv.color === "w") byWhite.push(mv.captured);
    else byBlack.push(mv.captured);
  }
  const sortPieces = (arr: PieceType[]): PieceType[] =>
    arr.sort((a, b) => PIECE_VALUES[b] - PIECE_VALUES[a]);
  return { byWhite: sortPieces(byWhite), byBlack: sortPieces(byBlack) };
}

/** Material em peões: >0 brancas na frente, <0 pretas. */
export function materialBalance(list: PieceOnSquare[]): number {
  let total = 0;
  for (const p of list) total += (p.color === "w" ? 1 : -1) * PIECE_VALUES[p.type];
  return total;
}

export interface EndState {
  endReason: EndReason;
  result: GameResult;
  winner?: Color;
}

/** Fim de jogo pela posição (mate, afogamento, material, repetição, 50 lances) ou `null`. */
export function endState(chess: Chess): EndState | null {
  if (chess.isCheckmate()) {
    const winner = fromChessColor(chess.turn() === "w" ? "b" : "w");
    return { endReason: "checkmate", result: winner === "white" ? "1-0" : "0-1", winner };
  }
  if (chess.isStalemate()) return { endReason: "stalemate", result: "1/2-1/2" };
  if (chess.isInsufficientMaterial()) return { endReason: "insufficient_material", result: "1/2-1/2" };
  if (chess.isThreefoldRepetition()) return { endReason: "threefold_repetition", result: "1/2-1/2" };
  if (chess.isDrawByFiftyMoves()) return { endReason: "fifty_move_rule", result: "1/2-1/2" };
  return null;
}
