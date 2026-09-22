/**
 * Tabela de lances — a aba "Lances" do Caderno (decisão 9.2). No desktop a
 * navegação principal é a régua sob o tabuleiro (`MoveRibbon`); esta visão
 * existe para quem prefere ler a partida em colunas.
 *
 * O cabeçalho saiu: quem o desenha agora é a aba do `Notebook`.
 */
import { useEffect, useRef } from "react";
import type { MoveRecord } from "@shared/types";
import { San } from "./San";

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
          className={`mv${active ? " is-active" : ""}${move.by !== "human" ? " mv-ai" : ""}`}
          onClick={() => onSelect(move.ply === lastPly ? null : move.ply)}
          aria-current={active ? "true" : undefined}
          aria-label={`Ver posição após ${move.color === "white" ? `${move.moveNumber}.` : `${move.moveNumber}…`} ${move.san}`}
        >
          <San san={move.san} />
        </button>
      </td>
    );
  };

  return (
    <div className="movelist">
      <div className="movelist-scroll">
        {history.length === 0 ? (
          <p className="feed-empty">Nenhum lance ainda.</p>
        ) : (
          <table>
            <caption className="sr-only">Lances da partida; escolha um para ver a posição.</caption>
            <tbody>
              <tr>
                <td className="mv-num">
                  <button
                    type="button"
                    className={`mv mv-start${activePly === 0 ? " is-active" : ""}`}
                    onClick={() => onSelect(0)}
                    aria-label="Ver a posição inicial"
                    title="Posição inicial"
                  >
                    <span aria-hidden="true">⟲</span>
                  </button>
                </td>
                <td colSpan={2} className="mv-empty">
                  posição inicial
                </td>
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
      <div className="movelist-nav" role="group" aria-label="Navegar no histórico">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onSelect(0)}
          disabled={history.length === 0 || activePly === 0}
          aria-label="Posição inicial"
          title="Início (Home)"
        >
          <span aria-hidden="true">⏮</span>
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onSelect(Math.max(0, activePly - 1))}
          disabled={history.length === 0 || activePly === 0}
          aria-label="Lance anterior"
          title="Anterior (←)"
        >
          <span aria-hidden="true">◀</span>
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onSelect(activePly + 1 >= lastPly ? null : activePly + 1)}
          disabled={selectedPly === null}
          aria-label="Próximo lance"
          title="Próximo (→)"
        >
          <span aria-hidden="true">▶</span>
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onSelect(null)}
          disabled={selectedPly === null}
          aria-label="Voltar ao lance ao vivo"
          title="Ao vivo (End)"
        >
          <span aria-hidden="true">⏭</span>
        </button>
      </div>
    </div>
  );
}
