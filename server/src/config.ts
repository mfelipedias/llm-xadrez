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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env.PORT, 3939);
  const host = (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const dataDirRaw = (env.DATA_DIR ?? "./data").trim() || "./data";
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(ROOT_DIR, dataDirRaw);
  const anyHost = host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "::1";
  const displayHost = anyHost ? "localhost" : host;
  const baseUrl = `http://${displayHost}:${port}`;
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
  };
}

export const config: Config = loadConfig();
