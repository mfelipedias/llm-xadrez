/**
 * Preferências visuais persistidas em localStorage (docs/10 §2.5, §9.4, §9.5):
 * tema claro/escuro (padrão: o do sistema) e preset de casas do tabuleiro.
 *
 * O tema vive como `data-theme` em <html> e o preset como `data-board`; toda a
 * paleta sai de `styles.css`, então nenhum componente precisa saber cores.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type BoardPreset = "paper" | "wood" | "slate";

const THEME_KEY = "xadrez.theme";
const BOARD_KEY = "xadrez.board";

export const BOARD_PRESETS: { id: BoardPreset; label: string }[] = [
  { id: "paper", label: "Papel e oliva" },
  { id: "wood", label: "Madeira" },
  { id: "slate", label: "Ardósia" },
];

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: "Tema: do sistema",
  light: "Tema: claro",
  dark: "Tema: escuro",
};

function readStorage<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {
    /* localStorage bloqueado (modo privado): usa o padrão */
  }
  return fallback;
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignora */
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  /** Avança sistema → claro → escuro → sistema. */
  cycle: () => void;
  set: (mode: ThemeMode) => void;
}

export function useTheme(): ThemeState {
  const [mode, setMode] = useState<ThemeMode>(() =>
    readStorage(THEME_KEY, ["system", "light", "dark"] as const, "system"),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (ev: MediaQueryListEvent) => setSystemDark(ev.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    writeStorage(THEME_KEY, mode);
  }, [mode]);

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  const cycle = useCallback(() => {
    setMode((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  }, []);

  return { mode, resolved, cycle, set: setMode };
}

export interface BoardPresetState {
  preset: BoardPreset;
  set: (preset: BoardPreset) => void;
}

export function useBoardPreset(): BoardPresetState {
  const [preset, setPreset] = useState<BoardPreset>(() =>
    readStorage(BOARD_KEY, ["paper", "wood", "slate"] as const, "paper"),
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-board", preset);
    writeStorage(BOARD_KEY, preset);
  }, [preset]);

  return { preset, set: setPreset };
}

/**
 * Media query reativa. Usada onde a diferença entre larguras não é só de CSS
 * e sim de estrutura: o menu "⋯" do tablet e a aba "Ações" do celular
 * (docs/10 §3.3, §3.4).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    setMatches(mq.matches);
    const onChange = (ev: MediaQueryListEvent) => setMatches(ev.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** `prefers-reduced-motion: reduce` — desliga animações também no react-chessboard. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * Lê tokens de cor do `:root` já resolvidos. Necessário só para as setas do
 * react-chessboard, que viram atributos SVG (`stroke`/`fill`) e não aceitam `var()`.
 */
export function useCssColors(names: readonly string[], signal: string): Record<string, string> {
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const name of names) next[name] = styles.getPropertyValue(name).trim();
    setColors(next);
    // `names` é uma constante de módulo; `signal` muda quando o tema muda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
  return colors;
}
