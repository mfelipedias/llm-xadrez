/**
 * Régua de lances (docs/10 §3.2, decisão 9.2): uma linha horizontal rolável sob
 * o tabuleiro, onde os olhos já estão. Substitui a tabela `MoveList` no desktop
 * — a tabela continua existindo como visão alternativa do Caderno (Fase 2).
 */
import { useEffect, useRef } from "react";
import type { MoveRecord } from "@shared/types";
import { San } from "./San";

interface Row {
  moveNumber: number;
  white?: MoveRecord;
  black?: MoveRecord;
}

export interface MoveRibbonProps {
  history: MoveRecord[];
  /** Ply em revisão; null = ao vivo. */
  activePly: number | null;
  onSelect: (ply: number | null) => void;
  /** Lances que chegaram enquanto o aluno revisa (docs/10 §3.6). */
  liveCount?: number;
}

function label(move: MoveRecord): string {
  return move.color === "white" ? `${move.moveNumber}.` : `${move.moveNumber}…`;
}

export function MoveRibbon({ history, activePly, onSelect, liveCount = 0 }: MoveRibbonProps) {
  const rows: Row[] = [];
  for (const move of history) {
    let row = rows[rows.length - 1];
    if (!row || row.moveNumber !== move.moveNumber) {
      row = { moveNumber: move.moveNumber };
      rows.push(row);
    }
    if (move.color === "white") row.white = move;
    else row.black = move;
  }

  const lastPly = history.length > 0 ? history[history.length - 1].ply : 0;
  const current = activePly ?? lastPly;
  const startActive = history.length > 0 && current === 0;
  const activeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [current, history.length]);

  const moveButton = (move: MoveRecord | undefined) => {
    if (!move) return null;
    const active = move.ply === current;
    return (
      <button
        type="button"
        ref={active ? activeRef : undefined}
        className={`ribbon-move${active ? " is-active" : ""}`}
        onClick={() => onSelect(move.ply === lastPly ? null : move.ply)}
        aria-current={active ? "true" : undefined}
        aria-label={`Ver posição após ${label(move)} ${move.san}`}
        title={`Ver posição após ${label(move)} ${move.san}`}
      >
        <San san={move.san} />
      </button>
    );
  };

  return (
    <nav className="ribbon" aria-label="Lances">
      <p className="sr-only">Use as setas ← e → do teclado para navegar pelos lances; End volta ao vivo.</p>
      <button
        type="button"
        className={`ribbon-start${startActive ? " is-active" : ""}`}
        onClick={() => onSelect(0)}
        aria-current={startActive ? "true" : undefined}
        aria-label="Ver a posição inicial"
        title="Posição inicial (Home)"
        disabled={history.length === 0}
      >
        <span aria-hidden="true">⟲</span>
      </button>

      {history.length === 0 ? (
        <p className="ribbon-empty">Nenhum lance ainda.</p>
      ) : (
        <ol className="ribbon-list" ref={listRef}>
          {rows.map((row) => (
            <li key={row.moveNumber} className="ribbon-pair">
              <span className="ribbon-num" aria-hidden="true">
                {row.moveNumber}.
              </span>
              {moveButton(row.white)}
              {moveButton(row.black)}
            </li>
          ))}
        </ol>
      )}

      {activePly !== null && (
        <button type="button" className="btn btn-small btn-primary ribbon-live" onClick={() => onSelect(null)}>
          voltar ao vivo
          {liveCount > 0 && (
            <span className="ribbon-badge">
              <span aria-hidden="true">+{liveCount}</span>
              <span className="sr-only">
                {liveCount === 1 ? "1 lance novo ao vivo" : `${liveCount} lances novos ao vivo`}
              </span>
            </span>
          )}
        </button>
      )}
    </nav>
  );
}
