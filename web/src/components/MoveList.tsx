import { useEffect, useRef } from "react";
import type { MoveRecord } from "@shared/types";

interface MoveListProps {
  history: MoveRecord[];
  /** Ply selecionado para preview; null = ao vivo. */
  selectedPly: number | null;
  onSelect: (ply: number | null) => void;
}

interface Row {
  moveNumber: number;
  white?: MoveRecord;
  black?: MoveRecord;
}

export function MoveList({ history, selectedPly, onSelect }: MoveListProps) {
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
  const activePly = selectedPly ?? lastPly;
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePly]);

  const cell = (move: MoveRecord | undefined) => {
    if (!move) return <td className="mv-empty">…</td>;
    const active = move.ply === activePly;
    return (
      <td>
        <button
          type="button"
          ref={active ? activeRef : undefined}
          className={`mv${active ? " is-active" : ""}${move.by === "mcp" ? " mv-ai" : ""}`}
          onClick={() => onSelect(move.ply === lastPly ? null : move.ply)}
          aria-current={active ? "true" : undefined}
        >
          {move.san}
        </button>
      </td>
    );
  };

  return (
    <section className="movelist" aria-label="Lances">
      <header className="panel-title">
        <span>Lances</span>
        <span className="panel-subtitle">
          {history.length === 0 ? "nenhum ainda" : `${history.length} meios-lances`}
        </span>
      </header>
      <div className="movelist-scroll">
        {history.length === 0 ? (
          <p className="feed-empty">A partida ainda não começou.</p>
        ) : (
          <table>
            <tbody>
              <tr>
                <td className="mv-num">
                  <button
                    type="button"
                    className={`mv mv-start${activePly === 0 ? " is-active" : ""}`}
                    onClick={() => onSelect(0)}
                    title="Posição inicial"
                  >
                    ⟲
                  </button>
                </td>
                <td colSpan={2} className="mv-empty">posição inicial</td>
              </tr>
              {rows.map((row) => (
                <tr key={row.moveNumber}>
                  <td className="mv-num">{row.moveNumber}.</td>
                  {cell(row.white)}
                  {cell(row.black)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="movelist-nav" aria-label="Navegar no histórico">
        <button type="button" className="btn btn-small" onClick={() => onSelect(0)} disabled={history.length === 0 || activePly === 0} title="Início (Home)">⏮</button>
        <button type="button" className="btn btn-small" onClick={() => onSelect(Math.max(0, activePly - 1))} disabled={history.length === 0 || activePly === 0} title="Anterior (←)">◀</button>
        <button type="button" className="btn btn-small" onClick={() => onSelect(activePly + 1 >= lastPly ? null : activePly + 1)} disabled={selectedPly === null} title="Próximo (→)">▶</button>
        <button type="button" className="btn btn-small" onClick={() => onSelect(null)} disabled={selectedPly === null} title="Ao vivo (End)">⏭</button>
      </div>
    </section>
  );
}
