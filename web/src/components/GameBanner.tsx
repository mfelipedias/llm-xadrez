/**
 * Fim de partida (docs/10 §4, §5.1): o momento de encerramento que faltava.
 * Aparece na mesa, acima do tabuleiro, e leva as ações do momento — revisar,
 * nova partida, PGN. Substitui o `StatusBar` no estado "finished".
 */
import type { GameState } from "@shared/types";
import { statusText } from "../status";

export interface GameBannerProps {
  state: GameState;
  pgnUrl: string;
  onReview: () => void;
  onNewGame: () => void;
}

export function GameBanner({ state, pgnUrl, onReview, onNewGame }: GameBannerProps) {
  if (state.status !== "finished") return null;

  return (
    <div className="game-banner" role="status">
      <div className="game-banner-text">
        <strong>{statusText(state)}</strong>
        <span className="game-banner-result" aria-label={`Resultado ${state.result}`}>
          {state.result}
        </span>
      </div>
      <div className="game-banner-actions">
        <button type="button" className="btn btn-small" onClick={onReview} disabled={state.history.length === 0}>
          Revisar
        </button>
        <a className="btn btn-small" href={pgnUrl} download="partida.pgn">
          PGN
        </a>
        <button type="button" className="btn btn-small btn-primary" onClick={onNewGame}>
          Nova partida
        </button>
      </div>
    </div>
  );
}
