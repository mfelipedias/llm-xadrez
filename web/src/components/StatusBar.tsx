import type { Color, GameState } from "@shared/types";

const COLOR_LABEL: Record<Color, string> = { white: "brancas", black: "pretas" };

function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

export function statusText(state: GameState): string {
  const { seats } = state;

  if (state.status === "finished") {
    const winnerName = state.winner ? seats[state.winner].name : "";
    switch (state.endReason) {
      case "checkmate":
        return `Xeque-mate — ${winnerName} venceu`;
      case "stalemate":
        return "Empate por afogamento";
      case "insufficient_material":
        return "Empate por material insuficiente";
      case "threefold_repetition":
        return "Empate por repetição tripla";
      case "fifty_move_rule":
        return "Empate pela regra dos 50 lances";
      case "resignation":
        return state.winner
          ? `${seats[opposite(state.winner)].name} desistiu — ${winnerName} venceu`
          : "Partida encerrada por desistência";
      case "draw_agreed":
        return "Empate acordado";
      case "aborted":
        return "Partida abortada";
      default:
        return state.result === "1/2-1/2" ? "Empate" : `Partida encerrada (${state.result})`;
    }
  }

  if (state.status === "waiting") {
    const emptyColors = (["white", "black"] as Color[]).filter((c) => seats[c].kind === "empty");
    if (emptyColors.length === 2) return "Aguardando jogadores";
    if (emptyColors.length === 1) return `Aguardando a IA entrar (${COLOR_LABEL[emptyColors[0]]})`;
    return "Aguardando início";
  }

  const seat = seats[state.turn];
  const prefix = state.inCheck ? "Xeque! " : "";
  let text: string;
  if (seat.kind === "human") {
    const bothHuman = seats.white.kind === "human" && seats.black.kind === "human";
    text = `Vez das ${COLOR_LABEL[state.turn]} (${bothHuman ? seat.name : "você"})`;
  } else if (seat.kind === "mcp") {
    text = `${seat.name} está pensando…`;
  } else {
    text = `Aguardando a IA entrar (${COLOR_LABEL[state.turn]})`;
  }
  if (state.drawOffer) {
    text += ` · ${seats[state.drawOffer.by].name} ofereceu empate`;
  }
  return prefix + text;
}

export function StatusBar({ state }: { state: GameState }) {
  const text = statusText(state);
  const tone = state.status === "finished" ? "finished" : state.inCheck ? "check" : "normal";
  return (
    <div className={`status-bar status-${tone}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}
