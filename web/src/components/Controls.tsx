import { useState } from "react";
import type { Color, GameState } from "@shared/types";

interface ControlsProps {
  state: GameState;
  /** "board": botões sob o tabuleiro. "game": ações da partida (coluna direita). */
  group: "board" | "game";
  pgnUrl: string;
  busy: boolean;
  onFlip: () => void;
  onCopyFen: () => void;
  onTakeback: () => void;
  onClearHighlight: () => void;
  onNewGame: () => void;
  onResign: (color?: Color) => void;
  onDraw: (color?: Color) => void;
}

export function Controls(props: ControlsProps) {
  const { state, group, busy } = props;
  const [confirmResign, setConfirmResign] = useState(false);

  const humanColors = (["white", "black"] as Color[]).filter((c) => state.seats[c].kind === "human");
  const active = state.status === "active";
  const hasHuman = humanColors.length > 0;
  const hasHighlight = state.highlight !== null && (state.highlight.arrows.length > 0 || state.highlight.squares.length > 0);

  if (group === "board") {
    return (
      <div className="controls controls-board" aria-label="Ferramentas do tabuleiro">
        <button type="button" className="btn btn-small" onClick={props.onFlip} title="Virar o tabuleiro">
          ↻ Virar
        </button>
        <button type="button" className="btn btn-small" onClick={props.onCopyFen} title="Copiar FEN da posição">
          FEN
        </button>
        <a className="btn btn-small" href={props.pgnUrl} download="partida.pgn" title="Exportar PGN">
          PGN
        </a>
        <button
          type="button"
          className="btn btn-small"
          onClick={props.onTakeback}
          disabled={busy || !active || !hasHuman || state.history.length === 0}
          title="Desfazer até o seu último lance"
        >
          ↶ Voltar lance
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={props.onClearHighlight}
          disabled={busy || !hasHighlight}
          title="Limpar setas e casas destacadas"
        >
          ✎ Limpar desenho
        </button>
      </div>
    );
  }

  const resign = (color?: Color) => {
    setConfirmResign(false);
    props.onResign(color);
  };

  return (
    <div className="controls controls-game" aria-label="Ações da partida">
      <button type="button" className="btn btn-primary" onClick={props.onNewGame} disabled={busy}>
        Nova partida
      </button>
      {confirmResign ? (
        <span className="confirm-inline" role="group" aria-label="Confirmar desistência">
          <span>Desistir mesmo?</span>
          {humanColors.length === 2 ? (
            <>
              <button type="button" className="btn btn-small btn-danger" onClick={() => resign("white")}>Brancas</button>
              <button type="button" className="btn btn-small btn-danger" onClick={() => resign("black")}>Pretas</button>
            </>
          ) : (
            <button type="button" className="btn btn-small btn-danger" onClick={() => resign()}>Sim, desisto</button>
          )}
          <button type="button" className="btn btn-small" onClick={() => setConfirmResign(false)}>Não</button>
        </span>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => setConfirmResign(true)}
          disabled={busy || !active || !hasHuman}
        >
          Desistir
        </button>
      )}
      <button
        type="button"
        className="btn"
        onClick={() => props.onDraw(humanColors.length === 1 ? humanColors[0] : undefined)}
        disabled={busy || !active || !hasHuman}
        title={state.drawOffer ? "Aceitar o empate oferecido" : "Oferecer empate"}
      >
        {state.drawOffer && state.seats[state.drawOffer.by].kind !== "human" ? "Aceitar empate" : "Empate"}
      </button>
    </div>
  );
}
