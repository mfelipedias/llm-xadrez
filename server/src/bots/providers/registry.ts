/**
 * Registro de provedores e perfis de bot (docs/09, seções 2.1, 4.1 e 6).
 *
 * Responsabilidades:
 *  - presets embutidos (OpenRouter, Anthropic, Ollama, LM Studio, llama.cpp, vLLM, Jan, LiteLLM, custom);
 *  - ler/gravar `providers.json` (sem nunca serializar chaves);
 *  - resolver a chave de API a partir do **ambiente** (`apiKeyEnv`), mascarando-a para a UI;
 *  - instanciar o adaptador certo e cachear `listModels` (5 min) e o último `test`.
 *
 * Invariante de segurança: `ProviderConfig` não tem campo de chave. O que sai daqui para a
 * API/UI é `ProviderPublic` (`hasApiKey` + `apiKeyMasked`).
 */
import fs from "node:fs";
import path from "node:path";
import type { BotProfile, ModelInfo, ProviderPublic } from "../../../../shared/types.js";
import { createLogger } from "../../log.js";
import { createAnthropicProvider, type AnthropicOptions } from "./anthropic.js";
import { createOpenAiCompatProvider, type FetchLike } from "./openai-compat.js";
import { diagnoseProviderError, type Diagnosis } from "./diagnose.js";
import {
  MODELS_TIMEOUT_MS,
  ProviderError,
  isEffectivelyLocal,
  type ChatProvider,
  type ProviderConfig,
  type TestResult,
} from "./types.js";

const log = createLogger("providers");

export interface ProvidersFile {
  version: number;
  providers: ProviderConfig[];
  profiles: BotProfile[];
  defaults?: {
    profileId?: string;
    onMoveFailure?: { vsHuman?: "pause" | "random_legal"; vsBot?: "pause" | "random_legal" };
  };
}

/**
 * Campos aceitos em `PUT /api/providers/:id` (nunca `apiKey`). `null` (ou "") remove o
 * campo da config — ex.: `timeoutMs: null` volta ao default, `apiKeyEnv: null` tira a chave.
 */
export type ProviderPatch = { [K in keyof Omit<ProviderConfig, "id">]?: ProviderConfig[K] | null };

const MODELS_CACHE_MS = 5 * 60 * 1000;
/** Listagem de modelos pela UI: mais folga que o teste de conexão, bem menos que o chat. */
const MODELS_LIST_TIMEOUT_MS = 20_000;

/** Variáveis com cara de chave que a UI pode sugerir como `apiKeyEnv`. */
export const KEY_ENV_PATTERN = /(_API_KEY|_KEY|_TOKEN)$/;
/** Segredos do próprio servidor: nunca listados nem aceitos como `apiKeyEnv`. */
export const RESERVED_ENV_KEYS = new Set(["MCP_TOKEN", "ADMIN_TOKEN"]);

/** Falha ao gravar `providers.json` (pasta no lugar do arquivo, permissão...). Vira 500 na API. */
export class ProvidersFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvidersFileError";
  }
}

/* ------------------------------------------------------------------ */
/* Presets (docs/09, seção 4.1)                                        */
/* ------------------------------------------------------------------ */

export const PRESETS: Record<string, ProviderConfig> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    paid: true,
    toolMode: "native",
    modelsQuery: "supported_parameters=tools",
    extraHeaders: { "HTTP-Referer": "http://localhost:3939", "X-Title": "LLM Xadrez" },
    extraBody: { usage: { include: true }, reasoning: { effort: "low" } },
    timeoutMs: 60_000,
  },
  /**
   * Messages API direta (adaptador `anthropic.ts`, SDK com import dinâmico).
   * Modelos atuais (IDs exatos, sem sufixo de data), em `ANTHROPIC_MODELS`:
   * `claude-opus-5` (padrão), `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-8`,
   * `claude-fable-5-1`. O `extraBody` traz os defaults do plano; o adaptador descarta
   * `thinking`/`output_config` nos modelos que não os aceitam (ex.: Haiku 4.5).
   */
  anthropic: {
    id: "anthropic",
    name: "Anthropic (API direta)",
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    paid: true,
    toolMode: "native",
    extraBody: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  },
  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    toolMode: "auto",
    toolChoice: false,
    timeoutMs: 180_000,
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    toolMode: "auto",
    timeoutMs: 180_000,
  },
  llamacpp: {
    id: "llamacpp",
    name: "llama.cpp server (local)",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    local: true,
    toolMode: "auto",
    timeoutMs: 180_000,
  },
  vllm: {
    id: "vllm",
    name: "vLLM (local)",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    local: true,
    toolMode: "native",
    timeoutMs: 180_000,
  },
  jan: {
    id: "jan",
    name: "Jan (local)",
    kind: "openai",
    baseUrl: "http://localhost:1337/v1",
    local: true,
    toolMode: "auto",
    timeoutMs: 180_000,
  },
  litellm: {
    id: "litellm",
    name: "LiteLLM (proxy)",
    kind: "openai",
    baseUrl: "http://localhost:4000/v1",
    apiKeyEnv: "LITELLM_API_KEY",
    toolMode: "native",
  },
  custom: {
    id: "custom",
    name: "Gateway custom (OpenAI-compatível)",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    toolMode: "auto",
  },
};

export const PRESET_IDS: string[] = Object.keys(PRESETS);

/** Conjunto usado quando não existe `providers.json`. */
export function defaultProvidersFile(): ProvidersFile {
  return {
    version: 1,
    providers: [clone(PRESETS.openrouter), clone(PRESETS.anthropic), clone(PRESETS.lmstudio), clone(PRESETS.ollama)],
    profiles: [],
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** "sk-or-v1-abc…a1b2" → "sk-or-…a1b2". Só os 4 últimos caracteres são revelados. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  const tail = trimmed.slice(-4);
  if (trimmed.length <= 8) return `…${tail}`;
  return `${trimmed.slice(0, 6)}…${tail}`;
}

/** Remove qualquer campo de chave que tenha entrado por engano na config. */
function sanitizeConfig(cfg: Record<string, unknown>): ProviderConfig {
  const copy = { ...cfg };
  for (const forbidden of ["apiKey", "api_key", "key", "token", "authorization", "Authorization"]) {
    delete copy[forbidden];
  }
  return copy as unknown as ProviderConfig;
}

/** Mensagem de erro de gravação de `providers.json`, pronta para a UI. */
function describeWriteError(file: string, err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EISDIR") return isDirMessage(file);
  if (code === "EACCES" || code === "EPERM") {
    return `Sem permissão para gravar ${file}. No Docker, confira o dono do arquivo no host (o container roda como UID:GID do .env).`;
  }
  if (code === "EROFS") return `${file} está montado como somente leitura: remova o ":ro" do volume para a tela de provedores poder gravar.`;
  return `Não foi possível gravar ${file}${typeof code === "string" ? ` (${code})` : ""}: ${(err as Error)?.message ?? String(err)}`;
}

function isDirMessage(file: string): string {
  return (
    `${file} é uma pasta, não um arquivo — o Docker cria uma pasta quando o arquivo do volume ` +
    "não existe no host. Pare o container, apague a pasta ./providers.json, restaure o arquivo " +
    "(git checkout providers.json) e suba de novo."
  );
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface ProviderRegistryOptions {
  /** Caminho de `providers.json`. Se não existir, usa os presets em memória. */
  file?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Testes: não grava em disco. */
  readOnly?: boolean;
}

interface ModelsCacheEntry {
  at: number;
  models: ModelInfo[];
}

export class ProviderRegistry {
  private data: ProvidersFile;
  private readonly file: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => number;
  private readonly readOnly: boolean;

  private adapters = new Map<string, ChatProvider>();
  private modelsCache = new Map<string, ModelsCacheEntry>();
  private lastTest = new Map<string, ProviderPublic["lastTest"]>();
  /** Provedores injetados em memória (FakeProvider nos testes e no smoke). */
  private injected = new Map<string, ChatProvider>();

  constructor(opts: ProviderRegistryOptions = {}) {
    this.file = opts.file;
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? (() => Date.now());
    this.readOnly = opts.readOnly ?? false;
    this.data = this.read();
  }

  /* ------------------------------ arquivo ----------------------------- */

  private read(): ProvidersFile {
    if (this.file && isDirectory(this.file)) {
      log.warn(`${isDirMessage(this.file)} Usando presets embutidos (alterações não serão gravadas).`);
      return defaultProvidersFile();
    }
    if (!this.file || !fs.existsSync(this.file)) {
      if (this.file) log.info(`providers.json não encontrado em ${this.file}: usando presets embutidos`);
      return defaultProvidersFile();
    }
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProvidersFile>;
      const providers = Array.isArray(parsed.providers)
        ? parsed.providers.map((p) => sanitizeConfig(p as unknown as Record<string, unknown>)).filter((p) => !!p.id)
        : [];
      const profiles = Array.isArray(parsed.profiles) ? (parsed.profiles as BotProfile[]).filter((p) => !!p.id) : [];
      const out: ProvidersFile = { version: parsed.version ?? 1, providers, profiles };
      if (parsed.defaults) out.defaults = parsed.defaults;
      log.info(`providers.json carregado: ${providers.length} provedor(es), ${profiles.length} perfil(is)`);
      return out;
    } catch (err) {
      log.error(`providers.json inválido (${(err as Error).message}); usando presets embutidos`);
      return defaultProvidersFile();
    }
  }

  /** Recarrega do disco (útil se o usuário editou o arquivo à mão). */
  reload(): void {
    this.data = this.read();
    this.adapters.clear();
    this.modelsCache.clear();
  }

  /** Provedores que devem ir para o disco: os injetados em memória (fake) nunca vão. */
  private persistable(): ProviderConfig[] {
    return this.data.providers.filter((p) => !this.injected.has(p.id));
  }

  /**
   * Grava `providers.json`. Nunca escreve chaves (as configs não as têm).
   * Lança `ProvidersFileError` (mensagem pt-BR pronta) se o caminho não for gravável.
   */
  save(): void {
    if (!this.file || this.readOnly) return;
    if (isDirectory(this.file)) throw new ProvidersFileError(isDirMessage(this.file));
    const payload: ProvidersFile = {
      version: this.data.version || 1,
      providers: this.persistable().map((p) => sanitizeConfig(p as unknown as Record<string, unknown>)),
      profiles: this.data.profiles,
    };
    if (this.data.defaults) payload.defaults = this.data.defaults;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch (err) {
      const message = describeWriteError(this.file, err);
      log.error(message);
      throw new ProvidersFileError(message, { cause: err });
    }
    log.info(`providers.json gravado (${payload.providers.length} provedor(es))`);
  }

  /** Aplica uma mudança e grava; se a gravação falhar, desfaz a mudança em memória. */
  private mutate<T>(change: () => T): T {
    const snapshot = clone(this.data);
    const result = change();
    try {
      this.save();
    } catch (err) {
      this.data = snapshot;
      throw err;
    }
    return result;
  }

  /** Conteúdo serializado que iria para o disco (usado nos testes de segurança). */
  serialize(): string {
    const payload: ProvidersFile = {
      version: this.data.version || 1,
      providers: this.persistable().map((p) => sanitizeConfig(p as unknown as Record<string, unknown>)),
      profiles: this.data.profiles,
    };
    if (this.data.defaults) payload.defaults = this.data.defaults;
    return JSON.stringify(payload, null, 2);
  }

  /* ---------------------------- provedores ---------------------------- */

  list(): ProviderConfig[] {
    return this.data.providers.map((p) => clone(p));
  }

  get(id: string): ProviderConfig | undefined {
    const found = this.data.providers.find((p) => p.id === id);
    return found ? clone(found) : undefined;
  }

  has(id: string): boolean {
    return this.data.providers.some((p) => p.id === id);
  }

  /** Chave de API do provedor, lida do ambiente. Nunca vem do `providers.json`. */
  apiKey(id: string): string | undefined {
    const cfg = this.data.providers.find((p) => p.id === id);
    if (!cfg?.apiKeyEnv) return undefined;
    const value = this.env[cfg.apiKeyEnv];
    return value && value.trim() ? value.trim() : undefined;
  }

  hasApiKey(id: string): boolean {
    return !!this.apiKey(id);
  }

  /** Provedor pago e sem chave: mensagem pronta para o 400 da API. */
  missingKeyReason(id: string): string | null {
    const cfg = this.data.providers.find((p) => p.id === id);
    if (!cfg) return `Provedor "${id}" não existe.`;
    if (isEffectivelyLocal(cfg) || !cfg.apiKeyEnv) return null;
    if (this.apiKey(id)) return null;
    return `Provedor ${id} sem ${cfg.apiKeyEnv} no .env`;
  }

  toPublic(cfg: ProviderConfig): ProviderPublic {
    const key = this.apiKey(cfg.id);
    const pub: ProviderPublic = {
      id: cfg.id,
      name: cfg.name || cfg.id,
      kind: cfg.kind,
      hasApiKey: !!key,
      toolMode: cfg.toolMode ?? "native",
      local: isEffectivelyLocal(cfg),
      paid: cfg.paid ?? false,
    };
    if (cfg.baseUrl) pub.baseUrl = cfg.baseUrl;
    if (cfg.apiKeyEnv) pub.apiKeyEnv = cfg.apiKeyEnv;
    if (cfg.timeoutMs !== undefined) pub.timeoutMs = cfg.timeoutMs;
    // Configs antigas não gravavam `preset`: o id igual ao de um preset basta como pista.
    const preset = cfg.preset ?? (PRESETS[cfg.id] ? cfg.id : undefined);
    if (preset) pub.preset = preset;
    if (key) pub.apiKeyMasked = maskKey(key);
    const test = this.lastTest.get(cfg.id);
    if (test) pub.lastTest = test;
    return pub;
  }

  publicList(): ProviderPublic[] {
    return this.data.providers.map((p) => this.toPublic(p));
  }

  /**
   * Cria ou atualiza. `null`/"" num campo do patch remove o campo (volta ao default).
   * A validação de formato (id, URL, enum) é do chamador (`validateProviderUpsert`).
   */
  upsert(id: string, patch: ProviderPatch): ProviderConfig {
    const clean = sanitizeConfig({ ...patch } as Record<string, unknown>) as unknown as Record<string, unknown>;
    delete clean.id;
    this.mutate(() => {
      const index = this.data.providers.findIndex((p) => p.id === id);
      const current: Record<string, unknown> =
        index < 0 ? { id, name: id, kind: "openai" } : { ...(this.data.providers[index] as unknown as Record<string, unknown>) };
      for (const [key, value] of Object.entries(clean)) {
        if (value === undefined) continue;
        if (value === null || value === "") delete current[key];
        else current[key] = value;
      }
      if (typeof current.name !== "string" || !current.name.trim()) current.name = id;
      if (current.kind !== "anthropic") current.kind = "openai";
      const next = current as unknown as ProviderConfig;
      if (index < 0) this.data.providers.push(next);
      else this.data.providers[index] = next;
    });
    this.adapters.delete(id);
    this.modelsCache.delete(id);
    this.lastTest.delete(id);
    return clone(this.data.providers.find((p) => p.id === id) as ProviderConfig);
  }

  /** Próximo id livre a partir de `base`: "custom", "custom-2", "custom-3"... */
  freeId(base: string): string {
    if (!this.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!this.has(candidate)) return candidate;
    }
  }

  /**
   * Adiciona um provedor a partir de um preset. Com `id` explícito, colisão é erro; sem ele,
   * o id é o do preset com sufixo numérico se já existir (`custom-2`).
   */
  addPreset(preset: string, id?: string): ProviderConfig {
    const base = PRESETS[preset];
    if (!base) throw new ProviderError(`Preset "${preset}" não existe.`, { providerId: preset });
    const finalId = id ?? this.freeId(preset);
    if (this.has(finalId)) throw new ProviderError(`Já existe um provedor com id "${finalId}".`, { providerId: finalId });
    const cfg: ProviderConfig = { ...clone(base), id: finalId, preset };
    this.mutate(() => {
      this.data.providers.push(cfg);
    });
    return clone(cfg);
  }

  remove(id: string): boolean {
    const index = this.data.providers.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.mutate(() => {
      this.data.providers.splice(index, 1);
    });
    this.adapters.delete(id);
    this.modelsCache.delete(id);
    this.lastTest.delete(id);
    return true;
  }

  /**
   * NOMES (nunca valores) das variáveis de ambiente com cara de chave, definidas e não
   * vazias, exceto os segredos do próprio servidor. A UI sugere como `apiKeyEnv`.
   */
  envKeyNames(): string[] {
    return Object.keys(this.env)
      .filter((name) => KEY_ENV_PATTERN.test(name) && !RESERVED_ENV_KEYS.has(name) && !!this.env[name]?.trim())
      .sort();
  }

  /* ------------------------------ perfis ------------------------------ */

  profiles(): BotProfile[] {
    return this.data.profiles.map((p) => clone(p));
  }

  profile(id: string): BotProfile | undefined {
    const found = this.data.profiles.find((p) => p.id === id);
    return found ? clone(found) : undefined;
  }

  upsertProfile(profile: BotProfile): BotProfile {
    this.mutate(() => {
      const index = this.data.profiles.findIndex((p) => p.id === profile.id);
      if (index < 0) this.data.profiles.push(profile);
      else this.data.profiles[index] = { ...this.data.profiles[index], ...profile };
    });
    return clone(profile);
  }

  removeProfile(id: string): boolean {
    const index = this.data.profiles.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.mutate(() => {
      this.data.profiles.splice(index, 1);
    });
    return true;
  }

  defaults(): ProvidersFile["defaults"] {
    return this.data.defaults ? clone(this.data.defaults) : undefined;
  }

  /* ---------------------------- adaptadores --------------------------- */

  /** Registra um provedor pronto (FakeProvider nos testes/smoke), sem tocar no arquivo. */
  inject(provider: ChatProvider, cfg?: Partial<ProviderConfig>): void {
    this.injected.set(provider.id, provider);
    if (!this.has(provider.id)) {
      this.data.providers.push({
        id: provider.id,
        name: cfg?.name ?? provider.id,
        kind: provider.kind,
        local: true,
        toolMode: "native",
        ...cfg,
      } as ProviderConfig);
    }
  }

  /** Instancia (e cacheia) o adaptador do provedor. */
  provider(id: string): ChatProvider {
    const injected = this.injected.get(id);
    if (injected) return injected;
    const cached = this.adapters.get(id);
    if (cached) return cached;
    const cfg = this.data.providers.find((p) => p.id === id);
    if (!cfg) throw new ProviderError(`Provedor "${id}" não está configurado.`, { providerId: id });
    const key = this.apiKey(id);
    if (cfg.kind === "anthropic") {
      // Messages API via @anthropic-ai/sdk, com import dinâmico dentro do adaptador.
      const anthropicOpts: AnthropicOptions = { now: this.now };
      if (key) anthropicOpts.apiKey = key;
      const adapter = createAnthropicProvider(cfg, anthropicOpts);
      this.adapters.set(id, adapter);
      return adapter;
    }
    const opts: Parameters<typeof createOpenAiCompatProvider>[1] = { now: this.now };
    if (key) opts.apiKey = key;
    if (this.fetchImpl) opts.fetchImpl = this.fetchImpl;
    const adapter = createOpenAiCompatProvider(cfg, opts);
    this.adapters.set(id, adapter);
    return adapter;
  }

  /** Erro de uma chamada ao provedor → mensagem + dica (ciente do Docker). */
  diagnose(id: string, err: unknown, opts: { inDocker?: boolean; timeoutMs?: number } = {}): Diagnosis {
    const cfg = this.data.providers.find((p) => p.id === id) ?? { id, kind: "openai" as const };
    return diagnoseProviderError(err, cfg, opts);
  }

  /**
   * Teste de conexão: `GET /models` com timeout curto (MODELS_TIMEOUT_MS), independente do
   * `timeoutMs` do chat. Erros viram mensagem + `hint`; o resultado fica em `lastTest`.
   */
  async test(id: string, opts: { inDocker?: boolean } = {}): Promise<TestResult> {
    let result: TestResult;
    const started = this.now();
    try {
      const models = await this.provider(id).listModels({ timeoutMs: MODELS_TIMEOUT_MS });
      result = { ok: true, latencyMs: Math.max(0, this.now() - started), models: models.length };
    } catch (err) {
      const diag = this.diagnose(id, err, { inDocker: opts.inDocker, timeoutMs: MODELS_TIMEOUT_MS });
      result = diag.hint ? { ok: false, error: diag.error, hint: diag.hint } : { ok: false, error: diag.error };
    }
    const at = new Date(this.now()).toISOString();
    this.lastTest.set(id, result.ok ? { ok: true, at, latencyMs: result.latencyMs, models: result.models } : { ok: false, at, error: result.error });
    return result;
  }

  async models(id: string, refresh = false): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(id);
    if (!refresh && cached && this.now() - cached.at < MODELS_CACHE_MS) return cached.models;
    const models = await this.provider(id).listModels({ timeoutMs: MODELS_LIST_TIMEOUT_MS });
    this.modelsCache.set(id, { at: this.now(), models });
    return models;
  }
}
