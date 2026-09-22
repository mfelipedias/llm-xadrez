/**
 * Configuração do servidor (lê `.env` na raiz do repositório).
 * Ver docs/03-servidor.md, seção "Configuração".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do repositório (pasta que contém package.json, web/, data/...). */
export const ROOT_DIR = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

export type Lang = "pt-BR" | "en";

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseLang(raw: string | undefined): Lang {
  if (!raw) return "pt-BR";
  // No Windows/Git Bash a variável LANG do sistema pode vir como "en_US.UTF-8".
  return /^en/i.test(raw) ? "en" : "pt-BR";
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  lang: Lang;
  mcpToken: string;
  humanName: string;
  version: string;
  isProduction: boolean;
  /** URL sugerida para a UI, ex.: http://localhost:3939 */
  baseUrl: string;
  /** URL do endpoint MCP, ex.: http://localhost:3939/mcp */
  mcpUrl: string;
  /** Arquivo de provedores/perfis de bot (docs/09, seção 4.1). */
  providersFile: string;
  /** Recriar bots do `current-game.json` ao reiniciar o servidor. */
  botAutoResume: boolean;
  /** Id do perfil de bot sugerido na UI (vazio = o `defaults.profileId` do providers.json). */
  botDefaultProfile: string;
  /** Injeta o provedor determinístico "fake" no registry (smoke sem rede: `scripts/bot-smoke.ts`). */
  botFakeProvider: boolean;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env.PORT, 3939);
  const host = (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const dataDirRaw = (env.DATA_DIR ?? "./data").trim() || "./data";
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(ROOT_DIR, dataDirRaw);
  const anyHost = host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "::1";
  const displayHost = anyHost ? "localhost" : host;
  // PUBLIC_URL: URL pela qual os clientes alcançam o servidor (ex.: Docker com outra porta
  // no host, túnel). Só afeta as URLs exibidas/anunciadas, não o bind.
  const publicUrl = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const baseUrl = publicUrl || `http://${displayHost}:${port}`;
  const providersRaw = (env.PROVIDERS_FILE ?? "./providers.json").trim() || "./providers.json";
  const providersFile = path.isAbsolute(providersRaw) ? providersRaw : path.resolve(ROOT_DIR, providersRaw);
  return {
    port,
    host,
    dataDir,
    lang: parseLang(env.LANG),
    mcpToken: (env.MCP_TOKEN ?? "").trim(),
    humanName: (env.HUMAN_NAME ?? "").trim() || "Você",
    version: readVersion(),
    isProduction: env.NODE_ENV === "production",
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    providersFile,
    botAutoResume: parseBool(env.BOT_AUTORESUME, true),
    botDefaultProfile: (env.BOT_DEFAULT_PROFILE ?? "").trim(),
    botFakeProvider: parseBool(env.BOT_FAKE_PROVIDER, false),
  };
}

export const config: Config = loadConfig();
