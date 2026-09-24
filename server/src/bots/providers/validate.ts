/**
 * Validação do corpo de `PUT /api/providers/:id` (cria ou atualiza um provedor).
 *
 * Regras de segurança (docs/09, seção 6):
 *  - nenhuma chave de API entra pela API (`apiKey`, `token`...): só o NOME da variável;
 *  - `extraHeaders` não é editável pela API (um `Authorization` ali seria uma chave em
 *    texto no providers.json): só editando o arquivo à mão;
 *  - `apiKeyEnv` precisa ter cara de chave (`*_API_KEY`, `*_KEY`, `*_TOKEN`) e nunca pode
 *    ser um segredo do próprio servidor (MCP_TOKEN/ADMIN_TOKEN) — senão bastaria apontar a
 *    baseUrl para outro host para receber qualquer variável do ambiente como Bearer;
 *  - URL com usuário/senha embutidos é recusada (seria outra forma de gravar credencial).
 */
import type { ProviderConfig, ToolMode } from "./types.js";
import { KEY_ENV_PATTERN, RESERVED_ENV_KEYS, type ProviderPatch } from "./registry.js";

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const TOOL_MODES: ToolMode[] = ["native", "text", "auto"];
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

export const FORBIDDEN_KEY_FIELDS = ["apiKey", "api_key", "key", "token", "authorization", "Authorization"];

export type UpsertValidation = { ok: true; patch: ProviderPatch; created: boolean } | { ok: false; error: string };

function fail(error: string): UpsertValidation {
  return { ok: false, error };
}

/** `null` ou "" (depois de trim) = limpar o campo. */
function isClear(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

/** Valida uma baseUrl; devolve a URL normalizada (sem "/" no fim) ou a mensagem de erro. */
export function checkBaseUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim();
  const example = "ex.: http://host.docker.internal:11434/v1";
  if (text.length > 500) return { error: "baseUrl longa demais (máx. 500 caracteres)." };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: `baseUrl inválida: use uma URL http:// ou https:// completa (${example}).` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `baseUrl precisa começar com http:// ou https:// (${example}).` };
  }
  if (parsed.username || parsed.password) {
    return { error: "baseUrl não pode ter usuário/senha embutidos: coloque a chave numa variável do .env e use apiKeyEnv." };
  }
  return { url: text.replace(/\/+$/, "") };
}

/**
 * Valida e normaliza o corpo. `existing` é a config atual (undefined = criação).
 * Campos desconhecidos são ignorados; chaves e `extraHeaders` são recusados.
 */
export function validateProviderUpsert(id: string, body: unknown, existing: ProviderConfig | undefined): UpsertValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Corpo inválido: envie um objeto JSON.");
  const b = body as Record<string, unknown>;

  for (const forbidden of FORBIDDEN_KEY_FIELDS) {
    if (forbidden in b) {
      return fail("Chaves de API não são aceitas pela API: defina a variável de ambiente no .env e informe o nome dela em `apiKeyEnv`.");
    }
  }
  if ("extraHeaders" in b) {
    return fail("`extraHeaders` não pode ser alterado pela API (um Authorization ali gravaria uma chave no arquivo): edite o providers.json à mão.");
  }

  const created = !existing;
  if (created && !PROVIDER_ID_PATTERN.test(id)) {
    return fail("Id inválido: use de 1 a 40 caracteres entre a-z, 0-9, \"-\" e \"_\", começando por letra ou número.");
  }

  const patch: ProviderPatch = {};

  if ("name" in b && b.name !== undefined) {
    if (isClear(b.name)) patch.name = null;
    else if (typeof b.name !== "string" || b.name.trim().length > 80) return fail("`name` deve ser um texto de até 80 caracteres.");
    else patch.name = b.name.trim();
  }

  if ("kind" in b && b.kind !== undefined) {
    if (b.kind !== "openai" && b.kind !== "anthropic") return fail('`kind` deve ser "openai" ou "anthropic".');
    patch.kind = b.kind;
  }

  if ("baseUrl" in b && b.baseUrl !== undefined) {
    if (isClear(b.baseUrl)) patch.baseUrl = null;
    else if (typeof b.baseUrl !== "string") return fail("`baseUrl` deve ser um texto (URL http/https).");
    else {
      const checked = checkBaseUrl(b.baseUrl);
      if ("error" in checked) return fail(checked.error);
      patch.baseUrl = checked.url;
    }
  }

  if ("apiKeyEnv" in b && b.apiKeyEnv !== undefined) {
    if (isClear(b.apiKeyEnv)) patch.apiKeyEnv = null;
    else if (typeof b.apiKeyEnv !== "string") return fail("`apiKeyEnv` deve ser o NOME de uma variável de ambiente.");
    else {
      const name = b.apiKeyEnv.trim();
      if (!ENV_NAME_PATTERN.test(name) || name.length > 100) {
        return fail("`apiKeyEnv` deve ser o NOME de uma variável de ambiente (A-Z, 0-9 e _), ex.: MEU_SERVIDOR_API_KEY — nunca a chave em si.");
      }
      if (RESERVED_ENV_KEYS.has(name)) return fail(`${name} é um segredo do próprio servidor e não pode ser usado como chave de provedor.`);
      if (!KEY_ENV_PATTERN.test(name)) {
        return fail("`apiKeyEnv` precisa terminar em _API_KEY, _KEY ou _TOKEN (ex.: MEU_SERVIDOR_API_KEY).");
      }
      patch.apiKeyEnv = name;
    }
  }

  if ("toolMode" in b && b.toolMode !== undefined) {
    if (!TOOL_MODES.includes(b.toolMode as ToolMode)) return fail('`toolMode` deve ser "native", "text" ou "auto".');
    patch.toolMode = b.toolMode as ToolMode;
  }

  for (const flag of ["local", "paid", "toolChoice", "parallelToolCalls"] as const) {
    if (!(flag in b) || b[flag] === undefined) continue;
    if (b[flag] === null) patch[flag] = null;
    else if (typeof b[flag] !== "boolean") return fail(`\`${flag}\` deve ser true ou false.`);
    else patch[flag] = b[flag] as boolean;
  }

  if ("timeoutMs" in b && b.timeoutMs !== undefined) {
    if (isClear(b.timeoutMs)) patch.timeoutMs = null;
    else {
      const n = b.timeoutMs;
      if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
        return fail(`\`timeoutMs\` deve ser um inteiro entre ${MIN_TIMEOUT_MS} e ${MAX_TIMEOUT_MS} (ms).`);
      }
      patch.timeoutMs = n;
    }
  }

  if ("modelsPath" in b && b.modelsPath !== undefined) {
    if (isClear(b.modelsPath)) patch.modelsPath = null;
    else if (typeof b.modelsPath !== "string" || !/^\/[A-Za-z0-9._~\/-]{0,199}$/.test(b.modelsPath.trim())) {
      return fail('`modelsPath` deve ser um caminho começando por "/", ex.: /models.');
    } else patch.modelsPath = b.modelsPath.trim();
  }

  if ("modelsQuery" in b && b.modelsQuery !== undefined) {
    if (isClear(b.modelsQuery)) patch.modelsQuery = null;
    else if (typeof b.modelsQuery !== "string" || b.modelsQuery.length > 500) return fail("`modelsQuery` deve ser um texto curto.");
    else patch.modelsQuery = b.modelsQuery.trim().replace(/^\?/, "");
  }

  // Estado final: provedor OpenAI-compatível sem URL não tem para onde mandar nada.
  const finalKind = patch.kind ?? existing?.kind ?? "openai";
  const finalBaseUrl = patch.baseUrl === null ? undefined : (patch.baseUrl ?? existing?.baseUrl);
  if (finalKind === "openai" && !finalBaseUrl) {
    return fail("Provedor OpenAI-compatível exige `baseUrl` (ex.: http://host.docker.internal:11434/v1).");
  }

  return { ok: true, patch, created };
}
