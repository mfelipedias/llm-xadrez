import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Arrow, PieceDropHandlerArgs, PieceHandlerArgs, SquareHandlerArgs } from "react-chessboard";
import { Chess, type Move, type Square } from "chess.js";
import type { Color, GameState, HighlightSpec, MoveRecord } from "@shared/types";
import { useCssColors } from "../theme";
import { BoardKeyboard } from "./BoardKeyboard";
import { Figurine } from "./Figurine";
import { COLOR_LABEL } from "../status";

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
  /** "light" | "dark" — só para reler os tokens de cor das setas quando o tema muda. */
  themeSignal: string;
  reducedMotion: boolean;
  /** Envia o lance em UCI. Deve rejeitar (throw) se o servidor recusar. */
  onMove: (uci: string) => Promise<void>;
}

/**
 * As quatro cores semânticas do plano (docs/10 §2.4) + as duas tintas.
 * Casas usam `var()` direto (estilo inline resolve); setas precisam do valor
 * calculado porque viram atributos SVG.
 */
const SEMANTIC_VAR: Record<string, string> = {
  green: "--good",
  red: "--threat",
  blue: "--ink",
  yellow: "--attn-bright",
  orange: "--attn-bright",
  purple: "--ink-2",
};

const ARROW_TOKENS = ["--good", "--threat", "--ink", "--attn-bright", "--ink-2"] as const;

/** Cor de casa: `var(--good)` etc.; qualquer outra string CSS passa direto. */
function squareColor(color: string | undefined): string {
  const token = SEMANTIC_VAR[(color ?? "green").toLowerCase()];
  return token ? `var(${token})` : (color as string);
}

function overlay(color: string, alpha: number): string {
  const mix = `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  return `linear-gradient(${mix}, ${mix})`;
}

const PROMOTION_PIECES: { piece: "q" | "r" | "b" | "n"; key: "Q" | "R" | "B" | "N"; label: string }[] = [
  { piece: "q", key: "Q", label: "Dama" },
  { piece: "r", key: "R", label: "Torre" },
  { piece: "b", key: "B", label: "Bispo" },
  { piece: "n", key: "N", label: "Cavalo" },
];

export function Board({
  state,
  fen,
  previewMove,
  isPreview,
  interactive,
  orientation,
  highlight,
  themeSignal,
  reducedMotion,
  onMove,
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
  /**
   * Lance otimista: a posição resultante é mostrada na hora (a peça anda com a
   * animação da lib) e, se o servidor recusar, volta a `fen` — o que faz a peça
   * **voltar animada** em vez de remontar o tabuleiro com uma `key` (docs/10 §4
   * e pendência da Fase 1).
   */
  const [pendingFen, setPendingFen] = useState<string | null>(null);
  const promoDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setSelected(null);
    setPromotion(null);
    setPendingFen(null);
  }, [fen, interactive]);

  useEffect(() => {
    const dialog = promoDialog.current;
    if (!dialog) return;
    if (promotion && !dialog.open) dialog.showModal();
    if (!promotion && dialog.open) dialog.close();
  }, [promotion]);

  /*
   * O react-chessboard embrulha cada peça num `div[role="button"][tabindex="0"]`
   * do dnd-kit, sem nome acessível: são 27 paradas de tabulação anônimas (axe:
   * `aria-command-name`, serious) e um atalho de arrastar por teclado em inglês
   * que concorre com a grade acessível daqui. Como a lib não deixa desligar
   * isso, um observador limpa os atributos assim que eles aparecem — a peça
   * continua arrastável com o mouse, e o teclado usa o `BoardKeyboard`.
   */
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    const sanitize = () => {
      for (const el of root.querySelectorAll('[aria-roledescription="draggable"]')) {
        el.removeAttribute("role");
        el.removeAttribute("tabindex");
        el.removeAttribute("aria-roledescription");
        el.removeAttribute("aria-describedby");
        el.setAttribute("aria-hidden", "true");
      }
      // Instrução de arrastar do dnd-kit (em inglês) sem quem a referencie.
      const hint = document.getElementById("dnd-main-board");
      if (hint) hint.textContent = "";
    };
    sanitize();
    const observer = new MutationObserver(sanitize);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["role", "tabindex"] });
    return () => observer.disconnect();
  }, []);

  const arrowColors = useCssColors(ARROW_TOKENS, themeSignal);

  const legalTargets: Move[] = useMemo(() => {
    if (!chess || !selected) return [];
    return chess.moves({ square: selected, verbose: true });
  }, [chess, selected]);

  const lastMove = isPreview ? previewMove : (state.lastMove ?? null);

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
    const merge = (square: string, style: CSSProperties) => {
      extra.set(square, { ...(extra.get(square) ?? {}), ...style });
    };

    // Último lance: lavagem âmbar dessaturada (fica fora da escala semântica).
    if (lastMove) {
      add(lastMove.from, `linear-gradient(var(--sq-last), var(--sq-last))`);
      add(lastMove.to, `linear-gradient(var(--sq-last-to), var(--sq-last-to))`);
    }
    // Casas desenhadas pela IA: preenchimento + contorno interno (redundância p/ daltonismo).
    if (highlight) {
      for (const sq of highlight.squares) {
        const color = squareColor(sq.color);
        add(sq.square, overlay(color, 0.55));
        merge(sq.square, { boxShadow: `inset 0 0 0 3px ${color}` });
      }
    }
    if (kingInCheck) {
      add(
        kingInCheck,
        "radial-gradient(circle, color-mix(in oklab, var(--threat) 92%, transparent) 0%, color-mix(in oklab, var(--threat) 60%, transparent) 40%, transparent 72%)",
      );
      merge(kingInCheck, { boxShadow: "inset 0 0 0 2px var(--threat)" });
    }
    // Seleção: contorno, não preenchimento.
    if (selected) {
      merge(selected, { boxShadow: "inset 0 0 0 3px var(--ink)" });
    }
    for (const move of legalTargets) {
      const isCapture = move.isCapture();
      add(
        move.to,
        isCapture
          ? "radial-gradient(circle, transparent 60%, var(--sq-dot) 62%, var(--sq-dot) 74%, transparent 76%)"
          : "radial-gradient(circle, var(--sq-dot) 0%, var(--sq-dot) 19%, transparent 21%)",
      );
      merge(move.to, { cursor: "pointer" });
    }

    const result: Record<string, CSSProperties> = {};
    const squares = new Set([...layers.keys(), ...extra.keys()]);
    for (const square of squares) {
      const list = layers.get(square);
      result[square] = {
        ...(extra.get(square) ?? {}),
        // Camadas mais recentes (seleção, destinos) ficam por cima.
        ...(list ? { backgroundImage: [...list].reverse().join(", ") } : {}),
      };
    }
    return result;
  }, [lastMove, highlight, kingInCheck, selected, legalTargets]);

  const arrows: Arrow[] = useMemo(
    () =>
      (highlight?.arrows ?? []).map((a) => {
        const token = SEMANTIC_VAR[(a.color ?? "green").toLowerCase()];
        const resolved = token ? arrowColors[token] : undefined;
        return {
          startSquare: a.from,
          endSquare: a.to,
          color: resolved || (token ? "#2e8b57" : (a.color as string)),
        };
      }),
    [highlight, arrowColors],
  );

  const send = (uci: string, nextFen: string) => {
    setPendingFen(nextFen);
    onMove(uci).catch(() => setPendingFen(null));
  };

  const attemptMove = (from: Square, to: Square): boolean => {
    if (!chess || !interactive || pendingFen) return false;
    const candidates = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (candidates.length === 0) return false;
    setSelected(null);
    if (candidates.some((m) => m.promotion)) {
      setPromotion({ from, to });
      return false;
    }
    send(`${from}${to}`, candidates[0].after);
    return true;
  };

  const onPieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
    if (!targetSquare || sourceSquare === targetSquare) return false;
    return attemptMove(sourceSquare as Square, targetSquare as Square);
  };

  const onSquareClick = ({ square, piece }: SquareHandlerArgs) => {
    if (!interactive || !chess || pendingFen) return;
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
    interactive && !pendingFen && piece.pieceType.startsWith(turnChar);

  const choosePromotion = (piece: "q" | "r" | "b" | "n") => {
    if (!promotion || !chess) return;
    const candidate = chess
      .moves({ square: promotion.from, verbose: true })
      .find((m) => m.to === promotion.to && m.promotion === piece);
    const uci = `${promotion.from}${promotion.to}${piece}`;
    setPromotion(null);
    if (candidate) send(uci, candidate.after);
    else void onMove(uci);
  };

  const shownFen = pendingFen ?? fen;
  const gridLabel = `Tabuleiro, ${state.status === "active" ? `vez das ${COLOR_LABEL[state.turn]}` : "partida parada"}`;

  return (
    <div
      ref={wrapRef}
      className={`board-wrap${isPreview ? " board-preview" : ""}${interactive ? " board-live" : ""}`}
    >
      <Chessboard
        options={{
          id: "main-board",
          position: shownFen,
          boardOrientation: orientation,
          animationDurationInMs: reducedMotion ? 0 : 180,
          allowDragging: interactive && !pendingFen,
          canDragPiece,
          onPieceDrop,
          onSquareClick,
          squareStyles,
          arrows,
          // O halo das setas (§2.5) é feito em CSS (`.board-wrap svg`), porque
          // `arrowOptions` exige o objeto inteiro de opções da lib.
          allowDrawingArrows: true,
          // Coordenadas vivem fora das casas, no `BoardFrame` (docs/10 §2.5).
          showNotation: false,
          darkSquareStyle: { backgroundColor: "var(--sq-dark)" },
          lightSquareStyle: { backgroundColor: "var(--sq-light)" },
          dropSquareStyle: { boxShadow: "inset 0 0 0 3px var(--ink)" },
          boardStyle: {
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            overflow: "hidden",
            width: "100%",
            height: "100%",
            position: "relative",
            borderRadius: "var(--r-sm)",
            // Em revisão o tabuleiro perde a sombra: sinal de "isto é uma cópia".
            boxShadow: isPreview ? "none" : "var(--shadow-board)",
          },
        }}
      />

      <BoardKeyboard
        chess={chess}
        orientation={orientation}
        interactive={interactive && !pendingFen}
        selected={selected}
        onSelect={setSelected}
        onMove={attemptMove}
        legalTargets={legalTargets.map((m) => m.to)}
        lastMove={lastMove}
        checkSquare={kingInCheck}
        label={gridLabel}
      />

      <dialog
        ref={promoDialog}
        className="promotion"
        aria-label="Escolha a peça de promoção"
        onClose={() => setPromotion(null)}
      >
        <p>Promover para:</p>
        <div className="promotion-options">
          {PROMOTION_PIECES.map((opt, index) => (
            <button
              key={opt.piece}
              type="button"
              className="btn promotion-btn"
              onClick={() => choosePromotion(opt.piece)}
              aria-label={opt.label}
              title={opt.label}
              autoFocus={index === 0}
            >
              <Figurine piece={opt.key} side={turnColor === "white" ? "w" : "b"} />
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-small" onClick={() => promoDialog.current?.close()}>
          Cancelar
        </button>
      </dialog>
    </div>
  );
}
