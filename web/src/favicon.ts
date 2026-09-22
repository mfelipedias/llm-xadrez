/**
 * Favicon dinâmico (docs/10 §4): o mesmo cavalo de `public/favicon.svg`, com um
 * ponto no canto quando há algo esperando por você na aba — sua vez ou um
 * comentário novo que você ainda não leu.
 *
 * É SVG embutido em `data:` porque o ícone muda muitas vezes por partida e não
 * vale um arquivo por estado. Cores são literais: o navegador desenha o ícone
 * fora do documento, onde as variáveis de tema não existem.
 */
export type FaviconState = "idle" | "turn" | "comment" | "thinking";

const DOT_COLOR: Record<Exclude<FaviconState, "idle">, string> = {
  turn: "#f2c14e",
  comment: "#8fb4ff",
  thinking: "#aab4c0",
};

function svg(state: FaviconState): string {
  const dot =
    state === "idle"
      ? ""
      : `<circle cx="50" cy="14" r="12" fill="${DOT_COLOR[state]}" stroke="#0d1117" stroke-width="2"/>`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    '<rect width="64" height="64" rx="12" fill="#1c2431"/>',
    '<g fill="#f3e9d2" stroke="#0d1117" stroke-width="2" stroke-linejoin="round">',
    '<circle cx="32" cy="17" r="8"/>',
    '<path d="M25 27h14l3 8-3 3h-14l-3-3z"/>',
    '<path d="M28 38h8l4 10H24z"/>',
    '<path d="M17 52c0-3 6-4 15-4s15 1 15 4v4H17z"/>',
    "</g>",
    dot,
    "</svg>",
  ].join("");
}

let current: FaviconState | null = null;

export function setFavicon(state: FaviconState): void {
  if (state === current) return;
  current = state;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg(state))}`;
}
