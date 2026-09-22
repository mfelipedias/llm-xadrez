/**
 * Figurinhas de peça em SVG inline (docs/10 §2.3, §5.1 — Fase 3).
 *
 * Substituem os glifos Unicode (♞) usados na Fase 1: os glifos dependem da
 * fonte de símbolos do sistema operacional e rendem diferente em cada máquina
 * (diagnóstico §1.2). Aqui são silhuetas próprias, desenhadas em `currentColor`,
 * que herdam tamanho do texto (`1em`) e funcionam em qualquer tema.
 *
 * `side` controla a leitura visual: "b" (padrão, também o da notação impressa)
 * é sólida; "w" é vazada com contorno, para as peças capturadas nas placas.
 */
import type { PieceType } from "@shared/types";

export type FigurineKey = "K" | "Q" | "R" | "B" | "N" | "P";

const PATHS: Record<FigurineKey, string> = {
  P: "M12 4.2a3.3 3.3 0 0 1 1.9 6c1.7 1.1 2.7 3 3.2 5.8H6.9c.5-2.8 1.5-4.7 3.2-5.8A3.3 3.3 0 0 1 12 4.2Z M5.6 17h12.8l1.1 4.8H4.5Z",
  N: "M7.2 21.8c-.2-4.6 1.2-7.3 4.2-9.6l-1.7-1.6-2 1.8-1.6-1.6 2.3-4.3 3.7-2.3V2.4l2.6 1.4c3.3 1.8 5 5.2 5 10.2v7.8Z",
  B:
    "M12 2.6c.95 0 1.7.75 1.7 1.7 0 .6-.3 1.1-.8 1.4 2.2 1.4 3.4 3.5 3.4 5.5 0 2.2-1.3 3.7-2.6 4.6l1 1.1-1.1 1.1h-3.2l-1.1-1.1 1-1.1C9 14.9 7.7 13.4 7.7 11.2c0-2 1.2-4.1 3.4-5.5-.5-.3-.8-.8-.8-1.4 0-.95.75-1.7 1.7-1.7Z " +
    "M5.6 17.4h12.8l1.1 4.4H4.5Z",
  R: "M5.6 3.4H8.8V5.6h2.1V3.4h2.2v2.2h2.1V3.4h3.2v6.4l-1.9 1.9v5.5l1.9 1.9v2.7H5.6v-2.7l1.9-1.9v-5.5L5.6 9.8Z",
  Q:
    "M3.2 6.4l2.9 4.2 2.1-6.2 3.8 6.2 3.8-6.2 2.1 6.2 2.9-4.2-1.9 10.6H5.1Z " +
    "M4.6 18.2h14.8l.6 3.6H4Z",
  K:
    "M10.9 1.6h2.2v2.1h2.1v2.2h-2.1v2.1h-2.2V5.9H8.8V3.7h2.1Z " +
    "M12 8.4c4 0 6.9 2.6 6.9 5.8 0 1.4-.5 2.4-1.1 3.2H6.2c-.6-.8-1.1-1.8-1.1-3.2 0-3.2 2.9-5.8 6.9-5.8Z " +
    "M4.6 18.2h14.8l.6 3.6H4Z",
};

export const PIECE_WORD: Record<FigurineKey, string> = {
  K: "rei",
  Q: "dama",
  R: "torre",
  B: "bispo",
  N: "cavalo",
  P: "peão",
};

/** "n" → "N". Aceita as letras de `PieceType` (minúsculas) e de SAN (maiúsculas). */
export function figurineKey(piece: PieceType | string): FigurineKey | null {
  const key = String(piece).toUpperCase();
  return key in PATHS ? (key as FigurineKey) : null;
}

export interface FigurineProps {
  piece: FigurineKey;
  /** "b" (padrão) desenha sólido; "w" desenha vazado com contorno. */
  side?: "w" | "b";
  className?: string;
}

/**
 * Sempre `aria-hidden`: quem chama é responsável pelo texto alternativo
 * (em `San` é a leitura em português; nas placas, o resumo das capturas).
 */
export function Figurine({ piece, side = "b", className = "" }: FigurineProps) {
  return (
    <svg
      className={`fig fig-${side}${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      focusable="false"
      aria-hidden="true"
    >
      <path d={PATHS[piece]} />
    </svg>
  );
}
