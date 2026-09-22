/**
 * Alternador de tema (decisão 9.5): segue o sistema por padrão e cicla
 * sistema → claro → escuro. A preferência fica em localStorage (`theme.ts`).
 */
import type { ThemeMode } from "../theme";
import { THEME_LABEL } from "../theme";

const ICON: Record<ThemeMode, string> = { system: "◐", light: "☀", dark: "☾" };
const NEXT: Record<ThemeMode, string> = {
  system: "claro",
  light: "escuro",
  dark: "o do sistema",
};

export function ThemeToggle({ mode, onCycle }: { mode: ThemeMode; onCycle: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={onCycle}
      aria-label={`${THEME_LABEL[mode]}. Mudar para ${NEXT[mode]}.`}
      title={`${THEME_LABEL[mode]} — clique para ${NEXT[mode]}`}
    >
      <span aria-hidden="true">{ICON[mode]}</span>
    </button>
  );
}
