/**
 * Montagem do feed do Caderno (docs/10 §3.1, §5.1): lances, comentários e
 * mensagens do aluno numa linha do tempo única, ordenada por hora.
 *
 * Vivia dentro do `LessonFeed`; virou módulo próprio porque o `Notebook`, a
 * `Annotation` e as regiões `aria-live` precisam dos mesmos dados.
 */
import type {
  Color,
  CommentCategory,
  Commentary,
  GameState,
  HighlightSpec,
  HumanMessage,
  MoveRecord,
} from "@shared/types";

export type FeedItem =
  | { kind: "move"; key: string; timestamp: string; ply: number; order: 0; move: MoveRecord }
  | { kind: "comment"; key: string; timestamp: string; ply: number; order: 1; comment: Commentary }
  | { kind: "message"; key: string; timestamp: string; ply: number; order: 2; message: HumanMessage };

export const CATEGORY_LABEL: Record<CommentCategory, string> = {
  lesson: "Aula",
  plan: "Plano",
  reaction: "Reação",
  question: "Pergunta",
  praise: "Elogio",
  warning: "Atenção",
  info: "Sistema",
};

/** Tinta de cada voz (§3.5): brancas `--ink`, pretas `--ink-2`, aluno grafite. */
export type Ink = "ink" | "ink-2" | "student" | "system";

export function inkFor(author: Color | "system"): Ink {
  if (author === "system") return "system";
  return author === "white" ? "ink" : "ink-2";
}

export function buildFeed(state: GameState): FeedItem[] {
  const list: FeedItem[] = [];
  for (const move of state.history) {
    list.push({ kind: "move", key: `m-${move.ply}`, timestamp: move.timestamp, ply: move.ply, order: 0, move });
  }
  for (const comment of state.commentary) {
    list.push({
      kind: "comment",
      key: `c-${comment.id}`,
      timestamp: comment.timestamp,
      ply: comment.ply,
      order: 1,
      comment,
    });
  }
  for (const message of state.humanMessages) {
    list.push({
      kind: "message",
      key: `h-${message.id}`,
      timestamp: message.timestamp,
      ply: message.ply,
      order: 2,
      message,
    });
  }
  list.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    if (a.ply !== b.ply) return a.ply - b.ply;
    return a.order - b.order;
  });
  return list;
}

/** Concorda com "seta" (feminino). */
const ARROW_COLOR: Record<string, string> = {
  green: "verde",
  red: "vermelha",
  blue: "azul",
  yellow: "âmbar",
  orange: "âmbar",
  purple: "roxa",
};

/** Concorda com "em <cor>" (masculino). */
const SQUARE_COLOR: Record<string, string> = {
  green: "verde",
  red: "vermelho",
  blue: "azul",
  yellow: "âmbar",
  orange: "âmbar",
  purple: "roxo",
};

/**
 * Texto oculto que descreve o desenho anexado a um comentário (docs/10 §6):
 * "desenho: seta verde de c6 para d4; casa d5 destacada em vermelho".
 */
export function describeHighlight(highlight: HighlightSpec | undefined): string {
  if (!highlight) return "";
  const parts: string[] = [];
  for (const arrow of highlight.arrows) {
    const color = ARROW_COLOR[(arrow.color ?? "green").toLowerCase()];
    parts.push(color ? `seta ${color} de ${arrow.from} para ${arrow.to}` : `seta de ${arrow.from} para ${arrow.to}`);
  }
  for (const square of highlight.squares) {
    const color = SQUARE_COLOR[(square.color ?? "green").toLowerCase()];
    parts.push(color ? `casa ${square.square} destacada em ${color}` : `casa ${square.square} destacada`);
  }
  if (parts.length === 0) return "";
  return `Desenho no tabuleiro: ${parts.join("; ")}.`;
}

export function hasDrawing(highlight: HighlightSpec | undefined): boolean {
  return !!highlight && (highlight.arrows.length > 0 || highlight.squares.length > 0);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function moveLabel(move: MoveRecord): string {
  return move.color === "white" ? `${move.moveNumber}. ${move.san}` : `${move.moveNumber}… ${move.san}`;
}

export function movePrefix(move: MoveRecord): string {
  return move.color === "white" ? `${move.moveNumber}.` : `${move.moveNumber}…`;
}

export function humanName(state: GameState): string {
  const human = (["white", "black"] as Color[]).find((c) => state.seats[c].kind === "human");
  return human ? state.seats[human].name : "Você";
}
