import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Arrow, PieceDropHandlerArgs, PieceHandlerArgs, SquareHandlerArgs } from "react-chessboard";
import { Chess, type Move, type Square } from "chess.js";
import type { Color, GameState, HighlightSpec, MoveRecord } from "@shared/types";

interface BoardProps {
  state: GameState;
  /** FEN exibido (ao vivo ou preview). */
  fen: string;
  /** Lance destacado como "último lance" no preview (null = usa state.lastMove). */
  previewMove: MoveRecord | null;
  isPreview: boolean;
  interactive: boolean;
  orientation: Color;
  highlight: HighlightSpec | null;
  /** Envia o lance em UCI. Deve rejeitar (throw) se o servidor recusar. */
  onMove: (uci: string) => Promise<void>;
  /** Mudar este valor remonta o tabuleiro (usado para desfazer um drop recusado). */
  resetKey: number;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  green: "#22b14c",
  red: "#e53935",
  blue: "#1e88e5",
  yellow: "#fdd835",
  orange: "#fb8c00",
  purple: "#8e24aa",
};

function cssColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  return HIGHLIGHT_COLORS[color.toLowerCase()] ?? color;
}

function overlay(color: string, alpha: number): string {
  return `linear-gradient(color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent), color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent))`;
}

const PROMOTION_PIECES: { piece: "q" | "r" | "b" | "n"; label: string; glyph: Record<Color, string> }[] = [
  { piece: "q", label: "Dama", glyph: { white: "♕", black: "♛" } },
  { piece: "r", label: "Torre", glyph: { white: "♖", black: "♜" } },
  { piece: "b", label: "Bispo", glyph: { white: "♗", black: "♝" } },
  { piece: "n", label: "Cavalo", glyph: { white: "♘", black: "♞" } },
];

export function Board({
  state,
  fen,
  previewMove,
  isPreview,
  interactive,
  orientation,
  highlight,
  onMove,
  resetKey,
}: BoardProps) {
  const chess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch (err) {
      console.warn("[board] FEN inválido", fen, err);
      return null;
    }
  }, [fen]);

  const turnChar = chess ? chess.turn() : state.turn === "white" ? "w" : "b";
  const turnColor: Color = turnChar === "w" ? "white" : "black";

  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);

  useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [fen, interactive]);

  const legalTargets: Move[] = useMemo(() => {
    if (!chess || !selected) return [];
    return chess.moves({ square: selected, verbose: true });
  }, [chess, selected]);

  const lastMove = isPreview ? previewMove : state.lastMove ?? null;

  const kingInCheck: Square | null = useMemo(() => {
    if (!chess || !chess.inCheck()) return null;
    const squares = chess.findPiece({ type: "k", color: chess.turn() });
    return squares[0] ?? null;
  }, [chess]);

  const squareStyles = useMemo(() => {
    const layers = new Map<string, string[]>();
    const extra = new Map<string, CSSProperties>();
    const add = (square: string, layer: string) => {
      const list = layers.get(square) ?? [];
      list.push(layer);
      layers.set(square, list);
    };

    if (lastMove) {
      add(lastMove.from, overlay("#f6d55c", 0.45));
      add(lastMove.to, overlay("#f6d55c", 0.55));
    }
    if (highlight) {
      for (const sq of highlight.squares) {
        add(sq.square, overlay(cssColor(sq.color, HIGHLIGHT_COLORS.green), 0.6));
      }
    }
    if (kingInCheck) {
      add(
        kingInCheck,
        "radial-gradient(circle, rgba(229,57,53,0.95) 0%, rgba(229,57,53,0.65) 40%, rgba(229,57,53,0) 72%)",
      );
    }
    if (selected) {
      add(selected, overlay("#3fa7ff", 0.55));
    }
    for (const move of legalTargets) {
      const isCapture = move.isCapture();
      add(
        move.to,
        isCapture
          ? "radial-gradient(circle, transparent 60%, rgba(20,20,20,0.35) 62%, rgba(20,20,20,0.35) 74%, transparent 76%)"
          : "radial-gradient(circle, rgba(20,20,20,0.35) 0%, rgba(20,20,20,0.35) 19%, transparent 21%)",
      );
      extra.set(move.to, { cursor: "pointer" });
    }

    const result: Record<string, CSSProperties> = {};
    for (const [square, list] of layers) {
      // Camadas mais recentes (seleção, destinos) ficam por cima.
      result[square] = { ...(extra.get(square) ?? {}), backgroundImage: [...list].reverse().join(", ") };
    }
    return result;
  }, [lastMove, highlight, kingInCheck, selected, legalTargets]);

  const arrows: Arrow[] = useMemo(
    () =>
      (highlight?.arrows ?? []).map((a) => ({
        startSquare: a.from,
        endSquare: a.to,
        color: cssColor(a.color, HIGHLIGHT_COLORS.green),
      })),
    [highlight],
  );

  const attemptMove = (from: Square, to: Square): boolean => {
    if (!chess || !interactive) return false;
    const candidates = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (candidates.length === 0) return false;
    setSelected(null);
    if (candidates.some((m) => m.promotion)) {
      setPromotion({ from, to });
      return false;
    }
    void onMove(`${from}${to}`);
    return true;
  };

  const onPieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
    if (!targetSquare || sourceSquare === targetSquare) return false;
    return attemptMove(sourceSquare as Square, targetSquare as Square);
  };

  const onSquareClick = ({ square, piece }: SquareHandlerArgs) => {
    if (!interactive || !chess) return;
    const sq = square as Square;
    if (selected) {
      if (selected === sq) {
        setSelected(null);
        return;
      }
      if (attemptMove(selected, sq)) return;
    }
    const own = piece !== null && piece.pieceType.startsWith(turnChar);
    setSelected(own ? sq : null);
  };

  const canDragPiece = ({ piece }: PieceHandlerArgs): boolean =>
    interactive && piece.pieceType.startsWith(turnChar);

  const choosePromotion = (piece: "q" | "r" | "b" | "n") => {
    if (!promotion) return;
    const uci = `${promotion.from}${promotion.to}${piece}`;
    setPromotion(null);
    void onMove(uci);
  };

  return (
    <div className={`board-wrap${isPreview ? " board-preview" : ""}${interactive ? " board-live" : ""}`}>
      <Chessboard
        key={resetKey}
        options={{
          id: "main-board",
          position: fen,
          boardOrientation: orientation,
          animationDurationInMs: 200,
          allowDragging: interactive,
          canDragPiece,
          onPieceDrop,
          onSquareClick,
          squareStyles,
          arrows,
          allowDrawingArrows: true,
          showNotation: true,
          darkSquareStyle: { backgroundColor: "#7a94a8" },
          lightSquareStyle: { backgroundColor: "#dfe6ec" },
          darkSquareNotationStyle: { color: "#dfe6ec", fontSize: "11px", fontWeight: 600 },
          lightSquareNotationStyle: { color: "#5f7a90", fontSize: "11px", fontWeight: 600 },
          dropSquareStyle: { boxShadow: "inset 0 0 0 3px rgba(63,167,255,0.9)" },
          boardStyle: {
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            overflow: "hidden",
            width: "100%",
            height: "100%",
            position: "relative",
            borderRadius: "6px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          },
        }}
      />
      {promotion && (
        <div className="promotion" role="dialog" aria-label="Escolha a peça de promoção">
          <p>Promover para:</p>
          <div className="promotion-options">
            {PROMOTION_PIECES.map((opt) => (
              <button
                key={opt.piece}
                type="button"
                className="btn promotion-btn"
                onClick={() => choosePromotion(opt.piece)}
                aria-label={opt.label}
                title={opt.label}
              >
                <span aria-hidden="true">{opt.glyph[turnColor]}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-small" onClick={() => setPromotion(null)}>
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}
