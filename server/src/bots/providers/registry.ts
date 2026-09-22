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
import { ProviderError, type ChatProvider, type ProviderConfig, type TestResult } from "./types.js";

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

/** Campos aceitos em `PUT /api/providers/:id` (nunca `apiKey`). */
export type ProviderPatch = Partial<Omit<ProviderConfig, "id">>;

const MODELS_CACHE_MS = 5 * 60 * 1000;

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

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
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

  /** Grava `providers.json`. Nunca escreve chaves (as configs não as têm). */
  save(): void {
    if (!this.file || this.readOnly) return;
    const payload: ProvidersFile = {
      version: this.data.version || 1,
      providers: this.persistable().map((p) => sanitizeConfig(p as unknown as Record<string, unknown>)),
      profiles: this.data.profiles,
    };
    if (this.data.defaults) payload.defaults = this.data.defaults;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    log.info(`providers.json gravado (${payload.providers.length} provedor(es))`);
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
    if (cfg.local || !cfg.apiKeyEnv) return null;
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
      local: cfg.local ?? isLocalUrl(cfg.baseUrl),
      paid: cfg.paid ?? false,
    };
    if (cfg.baseUrl) pub.baseUrl = cfg.baseUrl;
    if (cfg.apiKeyEnv) pub.apiKeyEnv = cfg.apiKeyEnv;
    if (key) pub.apiKeyMasked = maskKey(key);
    const test = this.lastTest.get(cfg.id);
    if (test) pub.lastTest = test;
    return pub;
  }

  publicList(): ProviderPublic[] {
    return this.data.providers.map((p) => this.toPublic(p));
  }

  upsert(id: string, patch: ProviderPatch): ProviderConfig {
    const clean = sanitizeConfig({ ...patch } as Record<string, unknown>) as ProviderPatch;
    const index = this.data.providers.findIndex((p) => p.id === id);
    if (index < 0) {
      const created: ProviderConfig = {
        id,
        name: clean.name ?? id,
        kind: clean.kind ?? "openai",
        ...clean,
      };
      this.data.providers.push(created);
    } else {
      this.data.providers[index] = { ...this.data.providers[index], ...clean, id };
    }
    this.adapters.delete(id);
    this.modelsCache.delete(id);
    this.save();
    return clone(this.data.providers.find((p) => p.id === id) as ProviderConfig);
  }

  addPreset(preset: string, id = preset): ProviderConfig {
    const base = PRESETS[preset];
    if (!base) throw new ProviderError(`Preset "${preset}" não existe.`, { providerId: preset });
    if (this.has(id)) throw new ProviderError(`Já existe um provedor com id "${id}".`, { providerId: id });
    const cfg = { ...clone(base), id };
    this.data.providers.push(cfg);
    this.save();
    return clone(cfg);
  }

  remove(id: string): boolean {
    const index = this.data.providers.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.data.providers.splice(index, 1);
    this.adapters.delete(id);
    this.modelsCache.delete(id);
    this.lastTest.delete(id);
    this.save();
    return true;
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
    const index = this.data.profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) this.data.profiles.push(profile);
    else this.data.profiles[index] = { ...this.data.profiles[index], ...profile };
    this.save();
    return clone(profile);
  }

  removeProfile(id: string): boolean {
    const index = this.data.profiles.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.data.profiles.splice(index, 1);
    this.save();
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

  async test(id: string): Promise<TestResult> {
    let result: TestResult;
    try {
      result = await this.provider(id).test();
    } catch (err) {
      result = { ok: false, error: err instanceof ProviderError ? err.shortText : (err as Error).message };
    }
    const at = new Date(this.now()).toISOString();
    this.lastTest.set(id, result.ok ? { ok: true, at, latencyMs: result.latencyMs, models: result.models } : { ok: false, at, error: result.error });
    return result;
  }

  async models(id: string, refresh = false): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(id);
    if (!refresh && cached && this.now() - cached.at < MODELS_CACHE_MS) return cached.models;
    const models = await this.provider(id).listModels();
    this.modelsCache.set(id, { at: this.now(), models });
    return models;
  }
}
