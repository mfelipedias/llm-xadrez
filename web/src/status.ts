/**
 * Frases de status da partida. Antes vivia em `StatusBar.tsx`; o `StatusBar` saiu
 * (docs/10 §5.1) e o texto migrou para a `SeatPlate` (vez/xeque), o `GameBanner`
 * (fim de partida) e uma região `aria-live` invisível.
 */
import type { Color, GameState, Seat, SeatKind } from "@shared/types";

export const COLOR_LABEL: Record<Color, string> = { white: "brancas", black: "pretas" };
export const COLOR_TITLE: Record<Color, string> = { white: "Brancas", black: "Pretas" };

export function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

/** Tolerante a `SeatKind` novos (ex.: "bot"): qualquer coisa que não seja humano/vazio é IA. */
export function isAiSeat(seat: Seat): boolean {
  return seat.kind !== "human" && seat.kind !== "empty";
}

export function seatKindLabel(kind: SeatKind): string {
  switch (kind) {
    case "human":
      return "humano";
    case "mcp":
      return "IA via MCP";
    case "empty":
      return "assento livre";
    case "bot":
      return "IA do servidor";
    default:
      return "IA";
  }
}

/** Nome do ocupante ou, se o assento ficou vazio (leave_game), o nome da cor. */
function seatName(state: GameState, color: Color): string {
  const name = state.seats[color].name.trim();
  if (name) return name;
  return COLOR_TITLE[color];
}

export function statusText(state: GameState): string {
  const { seats } = state;

  if (state.status === "finished") {
    const winnerName = state.winner ? seatName(state, state.winner) : "";
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
          ? `${seatName(state, opposite(state.winner))} desistiu — ${winnerName} venceu`
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
  } else if (seat.kind === "empty") {
    text = `Aguardando a IA entrar (${COLOR_LABEL[state.turn]})`;
  } else {
    text = `${seat.name} está pensando…`;
  }
  if (state.drawOffer) {
    text += ` · ${seats[state.drawOffer.by].name} ofereceu empate`;
  }
  return prefix + text;
}
