/**
 * Logger mínimo com prefixo por módulo: [mcp], [api], [ws], [store], [http].
 * Nível controlado por LOG_LEVEL (debug|info|warn|error|silent). Default: info.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as keyof typeof LEVELS;
  return LEVELS[raw] ?? LEVELS.info;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  const emit = (level: Level, msg: string, rest: unknown[]): void => {
    if (LEVELS[level] < currentLevel()) return;
    const line = `${stamp()} ${tag} ${msg}`;
    if (level === "error") console.error(line, ...rest);
    else if (level === "warn") console.warn(line, ...rest);
    else console.log(line, ...rest);
  };
  return {
    debug: (msg, ...rest) => emit("debug", msg, rest),
    info: (msg, ...rest) => emit("info", msg, rest),
    warn: (msg, ...rest) => emit("warn", msg, rest),
    error: (msg, ...rest) => emit("error", msg, rest),
  };
}
