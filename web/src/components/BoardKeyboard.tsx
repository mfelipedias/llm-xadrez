/**
 * Camada de teclado do tabuleiro (docs/10 §6, Fase 3).
 *
 * O react-chessboard não expõe nenhum elemento focável: o diagnóstico (§1.7)
 * mediu "0 elementos focáveis, 0 role, sem aria-label por casa" — falha 2.1.1.
 * Esta camada é uma grade transparente de 64 células por cima do tabuleiro,
 * com `pointer-events: none` (o mouse continua caindo no tabuleiro real) e
 * apenas **uma** parada de tabulação (roving tabindex).
 *
 * Teclas:
 *   Tab            entra/sai do tabuleiro
 *   ← ↑ → ↓        movem a casa ativa (não navegam o histórico: o evento para aqui)
 *   Enter / Espaço selecionam a peça e depois o destino
 *   Esc            cancela a seleção
 *   Home / End     primeira / última coluna da fileira
 *   letra + número pulam para a casa ("e" e depois "4")
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Chess, Square } from "chess.js";
import type { Color } from "@shared/types";
import { PIECE_WORD, figurineKey } from "./Figurine";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

/** Concordância: "torre branca", "cavalo branco". */
const FEMININE = new Set(["Q", "R"]);
function colorWord(side: "w" | "b", key: string | null): string {
  const feminine = key !== null && FEMININE.has(key);
  if (side === "w") return feminine ? "branca" : "branco";
  return feminine ? "preta" : "preto";
}

export interface BoardKeyboardProps {
  chess: Chess | null;
  orientation: Color;
  /** Só então Enter tenta jogar. */
  interactive: boolean;
  selected: Square | null;
  onSelect: (square: Square | null) => void;
  /** Tenta o lance; devolve false se não for legal. */
  onMove: (from: Square, to: Square) => boolean;
  legalTargets: readonly string[];
  /** Casas do último lance, para o rótulo. */
  lastMove?: { from: string; to: string } | null;
  checkSquare: string | null;
  /** "Tabuleiro, vez das brancas" etc. */
  label: string;
}

function squareLabel(
  square: string,
  chess: Chess | null,
  selected: Square | null,
  legalTargets: readonly string[],
  lastMove: { from: string; to: string } | null | undefined,
  checkSquare: string | null,
): string {
  const piece = chess?.get(square as Square);
  const parts: string[] = [square];
  if (piece) {
    const key = figurineKey(piece.type);
    parts.push(`${key ? PIECE_WORD[key] : piece.type} ${colorWord(piece.color, key)}`);
  } else {
    parts.push("vazia");
  }
  if (square === selected) parts.push("selecionada");
  else if (legalTargets.includes(square)) parts.push(piece ? "captura possível" : "destino possível");
  if (square === checkSquare) parts.push("em xeque");
  if (lastMove && (square === lastMove.from || square === lastMove.to)) parts.push("último lance");
  return parts.join(", ");
}

export function BoardKeyboard(props: BoardKeyboardProps) {
  const { chess, orientation, interactive, selected, onSelect, onMove, legalTargets, checkSquare, label } = props;
  const [active, setActive] = useState<string>("e4");
  const pendingFile = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // A casa ativa acompanha a seleção feita com o mouse.
  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);

  const files = orientation === "white" ? [...FILES] : [...FILES].reverse();
  const ranks = orientation === "white" ? [...RANKS].reverse() : [...RANKS];

  const focusSquare = (square: string) => {
    setActive(square);
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-key-square="${square}"]`);
    el?.focus();
  };

  const step = (dFile: number, dRank: number) => {
    const file = FILES.indexOf(active[0] as (typeof FILES)[number]);
    const rank = RANKS.indexOf(active[1] as (typeof RANKS)[number]);
    const flip = orientation === "white" ? 1 : -1;
    const nextFile = Math.min(7, Math.max(0, file + dFile * flip));
    const nextRank = Math.min(7, Math.max(0, rank + dRank * flip));
    focusSquare(`${FILES[nextFile]}${RANKS[nextRank]}`);
  };

  const activate = (square: string) => {
    if (!interactive) return;
    if (selected) {
      if (selected === square) {
        onSelect(null);
        return;
      }
      if (onMove(selected, square as Square)) return;
    }
    const piece = chess?.get(square as Square);
    const turn = chess?.turn();
    onSelect(piece && turn && piece.color === turn ? (square as Square) : null);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    const key = ev.key;
    const handled = () => {
      ev.preventDefault();
      // As setas do histórico (App) escutam a janela: o tabuleiro fica com as suas.
      ev.stopPropagation();
    };
    switch (key) {
      case "ArrowLeft":
        handled();
        return step(-1, 0);
      case "ArrowRight":
        handled();
        return step(1, 0);
      case "ArrowUp":
        handled();
        return step(0, 1);
      case "ArrowDown":
        handled();
        return step(0, -1);
      case "Home":
        handled();
        return focusSquare(`${files[0]}${active[1]}`);
      case "End":
        handled();
        return focusSquare(`${files[7]}${active[1]}`);
      case "Enter":
      case " ":
        handled();
        return activate(active);
      case "Escape":
        if (selected) {
          handled();
          onSelect(null);
        }
        return;
      default:
        break;
    }
    if (/^[a-h]$/i.test(key)) {
      handled();
      pendingFile.current = key.toLowerCase();
      return;
    }
    if (/^[1-8]$/.test(key)) {
      handled();
      const file = pendingFile.current ?? active[0];
      pendingFile.current = null;
      focusSquare(`${file}${key}`);
    }
  };

  return (
    <div
      className="board-keys"
      role="grid"
      aria-label={label}
      ref={gridRef}
      onKeyDown={onKeyDown}
    >
      {ranks.map((rank) => (
        <div className="board-keys-row" role="row" key={rank}>
          {files.map((file) => {
            const square = `${file}${rank}`;
            const isActive = square === active;
            return (
              <div
                key={square}
                role="gridcell"
                data-key-square={square}
                className={`board-key${square === selected ? " is-selected" : ""}`}
                tabIndex={isActive ? 0 : -1}
                aria-selected={square === selected}
                aria-label={squareLabel(square, chess, selected, legalTargets, props.lastMove, checkSquare)}
                onFocus={() => setActive(square)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
