/**
 * Ações da partida (docs/10 §5.1) — a outra metade do antigo `Controls`.
 * "Nova partida" é a primária; "Desistir" só fica vermelho na confirmação.
 * No modo espectador (nenhum assento humano) desistir e empate somem (§3.5).
 *
 * A confirmação de desistir virou `popover` nativo (§4, §6): o navegador dá
 * Esc, fechamento ao clicar fora e devolução do foco ao botão; o foco inicial
 * vai para "Cancelar", nunca para a ação destrutiva (3.3.4).
 */
import { useRef, type SyntheticEvent } from "react";
import type { Color, GameState } from "@shared/types";

export interface GameActionsProps {
  state: GameState;
  busy: boolean;
  onNewGame: () => void;
  onResign: (color?: Color) => void;
  onDraw: (color?: Color) => void;
}

export function GameActions({ state, busy, onNewGame, onResign, onDraw }: GameActionsProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /*
   * O `popover` só move o foco sozinho se achar o atributo `autofocus` no HTML,
   * e o React aplica `autoFocus` só na montagem. Como o painel nasce escondido,
   * o foco é posto à mão quando ele abre — e vai para "Cancelar", nunca para a
   * ação destrutiva (3.3.4).
   */
  const onToggle = (ev: SyntheticEvent<HTMLDivElement>) => {
    if ((ev as unknown as { newState?: string }).newState === "open") cancelRef.current?.focus();
  };

  const humanColors = (["white", "black"] as Color[]).filter((c) => state.seats[c].kind === "human");
  const active = state.status === "active";
  const hasHuman = humanColors.length > 0;

  const resign = (color?: Color) => {
    popRef.current?.hidePopover?.();
    onResign(color);
  };

  const drawOffer = state.drawOffer ?? null;
  const drawOfferFromAi = drawOffer !== null && state.seats[drawOffer.by].kind !== "human";
  const drawOfferFromHuman = drawOffer !== null && state.seats[drawOffer.by].kind === "human";
  const winner = humanColors.length === 1 ? state.seats[humanColors[0] === "white" ? "black" : "white"].name : "";

  return (
    <div className="controls controls-game" aria-label="Ações da partida">
      <button type="button" className="btn btn-primary" onClick={onNewGame} disabled={busy}>
        Nova partida
      </button>

      {hasHuman && (
        <>
          <button
            type="button"
            className="btn"
            onClick={() => onDraw(humanColors.length === 1 ? humanColors[0] : undefined)}
            disabled={busy || !active || drawOfferFromHuman}
            title={drawOffer ? "Aceitar o empate oferecido" : "Oferecer empate"}
          >
            {drawOfferFromAi ? "Aceitar empate" : drawOfferFromHuman ? "Empate oferecido — aguardando" : "Empate"}
          </button>

          <button
            type="button"
            className="btn btn-quiet resign-btn"
            popoverTarget="resign-confirm"
            disabled={busy || !active}
          >
            Desistir
          </button>
          <div id="resign-confirm" ref={popRef} popover="auto" className="confirm-pop" onToggle={onToggle}>
            <p className="confirm-text">
              Desistir a partida?{winner ? ` ${winner} vence.` : ""} Não dá para voltar atrás.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-small"
                ref={cancelRef}
                onClick={() => popRef.current?.hidePopover?.()}
              >
                Cancelar
              </button>
              {humanColors.length === 2 ? (
                <>
                  <button type="button" className="btn btn-small btn-danger" onClick={() => resign("white")}>
                    Brancas desistem
                  </button>
                  <button type="button" className="btn btn-small btn-danger" onClick={() => resign("black")}>
                    Pretas desistem
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-small btn-danger" onClick={() => resign()}>
                  Desistir
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
