/**
 * Logger mínimo com prefixo por módulo: [mcp], [api], [ws], [store], [http], [providers].
 * Nível controlado por LOG_LEVEL (debug|info|warn|error|silent). Default: info.
 * Toda linha passa por `redact()` (docs/09, seção 6): nenhuma chave de API vai para o log.
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

/**
 * Apaga segredos de qualquer texto logado: chaves no formato `sk-…`/`xai-…`/`gsk-…`,
 * `Authorization: Bearer …` e pares `api_key = …` / `x-api-key: …`.
 */
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer …")
    .replace(/\b(x-api-key|api[_-]?key|anthropic-api-key|authorization)("?\s*[:=]\s*"?)[^"'\s,;}]{8,}/gi, "$1$2…")
    .replace(/\b(sk|xai|gsk)-[A-Za-z0-9_-]{8,}/gi, "$1-…");
}

function redactUnknown(value: unknown): unknown {
  return typeof value === "string" ? redact(value) : value;
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
    const line = redact(`${stamp()} ${tag} ${msg}`);
    const extra = rest.map(redactUnknown);
    if (level === "error") console.error(line, ...extra);
    else if (level === "warn") console.warn(line, ...extra);
    else console.log(line, ...extra);
  };
  return {
    debug: (msg, ...rest) => emit("debug", msg, rest),
    info: (msg, ...rest) => emit("info", msg, rest),
    warn: (msg, ...rest) => emit("warn", msg, rest),
    error: (msg, ...rest) => emit("error", msg, rest),
  };
}
