/**
 * Ferramentas do tabuleiro (docs/10 §5.1) — metade do antigo `Controls`.
 * Inclui o seletor de preset de casas (decisão 9.4).
 *
 * Entre 768 e 1099 px (§3.3) as ferramentas secundárias — FEN, PGN, limpar
 * desenho e preset — entram num menu "⋯" com `popover` nativo, e só "virar" e
 * "voltar lance" ficam visíveis. Motivo medido: a 1024 px os seis controles
 * mais o `select` quebram em duas linhas e roubam ~40 px de altura do
 * tabuleiro, que ali já é o elemento espremido.
 */
import { useId, useRef } from "react";
import type { GameState } from "@shared/types";
import { BOARD_PRESETS, useMediaQuery, type BoardPreset } from "../theme";

export interface BoardToolsProps {
  state: GameState;
  pgnUrl: string;
  busy: boolean;
  preset: BoardPreset;
  onPreset: (preset: BoardPreset) => void;
  onFlip: () => void;
  onCopyFen: () => void;
  onTakeback: () => void;
  onClearHighlight: () => void;
}

export function BoardTools({
  state,
  pgnUrl,
  busy,
  preset,
  onPreset,
  onFlip,
  onCopyFen,
  onTakeback,
  onClearHighlight,
}: BoardToolsProps) {
  const compact = useMediaQuery("(min-width: 768px) and (max-width: 1099px)");
  const menuId = useId().replace(/:/g, "");
  const menuRef = useRef<HTMLDivElement>(null);
  const active = state.status === "active";
  const hasHuman = state.seats.white.kind === "human" || state.seats.black.kind === "human";
  const hasHighlight =
    state.highlight !== null &&
    state.highlight.ply === state.ply &&
    (state.highlight.arrows.length > 0 || state.highlight.squares.length > 0);

  const close = () => menuRef.current?.hidePopover?.();

  const secondary = (
    <>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          onClearHighlight();
          close();
        }}
        disabled={busy || !hasHighlight}
        title="Limpar setas e casas destacadas"
      >
        <span aria-hidden="true">✎</span> Limpar desenho
      </button>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          onCopyFen();
          close();
        }}
        title="Copiar FEN da posição"
      >
        FEN
      </button>
      <a className="btn btn-small" href={pgnUrl} download="partida.pgn" title="Exportar PGN" onClick={close}>
        PGN
      </a>
      <label className="board-preset">
        <span className="board-preset-label">Casas</span>
        <select value={preset} onChange={(ev) => onPreset(ev.target.value as BoardPreset)}>
          {BOARD_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <div className="controls controls-board" aria-label="Ferramentas do tabuleiro">
      <button type="button" className="btn btn-small" onClick={onFlip} title="Virar o tabuleiro">
        <span aria-hidden="true">↻</span> Virar
      </button>
      <button
        type="button"
        className="btn btn-small"
        onClick={onTakeback}
        disabled={busy || !active || !hasHuman || state.history.length === 0}
        title="Desfazer até o seu último lance"
      >
        <span aria-hidden="true">↶</span> Voltar lance
      </button>

      {compact ? (
        <>
          <button type="button" className="btn btn-small tool-menu-btn" popoverTarget={menuId} aria-label="Mais ferramentas">
            <span aria-hidden="true">⋯</span>
          </button>
          <div id={menuId} ref={menuRef} popover="auto" className="tool-menu">
            {secondary}
          </div>
        </>
      ) : (
        secondary
      )}
    </div>
  );
}
