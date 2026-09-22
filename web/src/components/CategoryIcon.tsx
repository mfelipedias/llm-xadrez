/**
 * Ícone da categoria do comentário em SVG (docs/10 §6: "categoria de comentário
 * tem ícone SVG + texto"). Substitui os emojis do `CATEGORY_META` da Fase 1,
 * que rendiam diferente em cada sistema operacional e traziam cores fora da
 * paleta (diagnóstico §1.2).
 *
 * O ícone é decorativo: o rótulo em texto ("Aula", "Pergunta"…) vai sempre ao
 * lado, então nada depende só de cor ou só de forma.
 */
import type { CommentCategory } from "@shared/types";

const ICONS: Record<CommentCategory, string> = {
  // lâmpada
  lesson: "M12 2.5a6 6 0 0 0-3.4 10.9c.5.4.8.9.9 1.5l.1.6h4.8l.1-.6c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 2.5Zm-2.2 15h4.4M10.3 20h3.4",
  // alvo
  plan: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm0 4.3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 3.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z",
  // balão
  reaction: "M4 5.5h16v11H9.5L5 20.5v-4H4Z",
  // interrogação
  question: "M8.6 8.4a3.5 3.5 0 1 1 4.3 3.4c-.6.2-.9.7-.9 1.3v1.1M12 18.6v1.2",
  // estrela
  praise: "m12 3 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.2l5.9-.8Z",
  // triângulo de atenção
  warning: "M12 3.4 21.2 20H2.8Zm0 5.6v5.2m0 2.3v1.2",
  // "i"
  info: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm0 3.4v1.6m0 3v6.2",
};

/** Categorias desenhadas com traço (não preenchidas). */
const STROKED: CommentCategory[] = ["lesson", "reaction", "question", "warning", "info"];

export function CategoryIcon({ category }: { category: CommentCategory }) {
  const stroked = STROKED.includes(category);
  return (
    <svg
      className={`cat-icon${stroked ? " cat-icon-stroke" : ""}`}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      focusable="false"
      aria-hidden="true"
    >
      <path d={ICONS[category] ?? ICONS.info} />
    </svg>
  );
}
