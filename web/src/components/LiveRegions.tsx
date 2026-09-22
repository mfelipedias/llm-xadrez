/**
 * Regiões `aria-live` fixas (docs/10 §6, Fase 3).
 *
 * O diagnóstico (§1.7) achou uma falha de 4.1.3: o `aria-live` do feed era
 * posto **no último item**, ou seja, o atributo migrava para um nó novo a cada
 * comentário — e leitores de tela não anunciam uma região que nasce junto com
 * o conteúdo. Aqui os dois nós existem desde o primeiro render e vazios; só o
 * texto dentro deles muda.
 *
 *  #sr-moves    lance, xeque e de quem é a vez
 *  #sr-comments comentário novo da professora, com o texto inteiro
 */
import { useEffect, useRef, useState } from "react";
import type { GameState } from "@shared/types";
import { CATEGORY_LABEL, describeHighlight } from "../feed";
import { COLOR_LABEL, statusText } from "../status";
import { spokenSan } from "./San";

function moveSentence(state: GameState): string {
  const move = state.lastMove;
  if (!move) return statusText(state);
  const author = state.seats[move.color].name || COLOR_LABEL[move.color];
  const suffix = move.isCheckmate ? ", xeque-mate" : move.isCheck ? ", xeque" : "";
  const spoken = spokenSan(move.san).replace(/, (mate|xeque)$/, "");
  return `${author} jogou ${spoken}${suffix}.`;
}

/** Tira a marcação de markdown: `**forte**` e `código` viram texto corrido. */
function plain(text: string): string {
  return text.replace(/[*_`]/g, "");
}

function turnSentence(state: GameState): string {
  if (state.status !== "active") return statusText(state);
  const seat = state.seats[state.turn];
  if (seat.kind === "human") return "Sua vez.";
  if (seat.kind === "empty") return `Aguardando a IA entrar nas ${COLOR_LABEL[state.turn]}.`;
  return `${seat.name} está pensando.`;
}

export function LiveRegions({ state }: { state: GameState }) {
  const [moves, setMoves] = useState("");
  const [comments, setComments] = useState("");
  const seen = useRef<{ id: string; ply: number; status: string; comment: string } | null>(null);

  useEffect(() => {
    const last = state.commentary[state.commentary.length - 1];
    const prev = seen.current;
    seen.current = { id: state.id, ply: state.ply, status: state.status, comment: last?.id ?? "" };

    // Primeiro render (ou partida nova): não anuncia nada retroativamente.
    if (!prev || prev.id !== state.id) return;

    if (state.ply !== prev.ply) {
      setMoves(`${moveSentence(state)} ${turnSentence(state)}`);
    } else if (state.status !== prev.status) {
      setMoves(statusText(state));
    }

    if (last && last.id !== prev.comment) {
      const label = CATEGORY_LABEL[last.category];
      const category = last.category === "info" || !label ? "" : `, ${label.toLowerCase()}`;
      setComments(`${last.authorName}${category}: ${plain(last.text)} ${describeHighlight(last.highlight)}`.trim());
    }
  }, [state]);

  return (
    <>
      <p id="sr-moves" className="sr-only" role="status" aria-live="polite">
        {moves}
      </p>
      <p id="sr-comments" className="sr-only" role="status" aria-live="polite">
        {comments}
      </p>
    </>
  );
}
