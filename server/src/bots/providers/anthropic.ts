/**
 * Adaptador da Messages API da Anthropic (docs/09, seção 2.3) sobre o SDK oficial
 * `@anthropic-ai/sdk`, carregado por **import dinâmico**: quem não usa um provedor
 * `kind: "anthropic"` nunca paga o custo de carregar o pacote.
 *
 * O que este arquivo resolve (o loop agentic continua no BotPlayer):
 *  - `system` vira bloco de texto com `cache_control: { type: "ephemeral" }` — o prompt de
 *    sistema é estável durante a partida, então cada lance lê o prefixo do cache;
 *  - `thinking: { type: "adaptive" }` + `output_config: { effort: "low" }` nos modelos que
 *    aceitam (escolher um lance não precisa de raciocínio caro); `thinking: "off"` tira os dois;
 *  - blocos `tool_use` da resposta viram `ToolCall`, e os `tool` results da interface voltam
 *    como blocos `tool_result` **numa única mensagem `user`** (exigência do formato);
 *  - `tool_choice` nunca é `any`/`tool` (o Fable 5.1 devolve 400): só `auto` ou `none`;
 *  - `temperature` é descartada nos modelos 4.7+/5, que rejeitam parâmetros de amostragem;
 *  - erros do SDK viram `ProviderError` com `status`/`retryable`/`retryAfterMs`, como no
 *    `openai-compat.ts`, e o custo (inclusive tokens de cache) é estimado para o orçamento.
 *
 * Nada aqui guarda chave: ela chega do registry, lida do ambiente.
 */
import type { ModelInfo } from "../../../../shared/types.js";
import { createLogger } from "../../log.js";
import {
  ProviderError,
  MODELS_TIMEOUT_MS,
  defaultTimeoutMs,
  isEffectivelyLocal,
  type ListModelsOptions,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  type FinishReason,
  type ProviderConfig,
  type TestResult,
  type ToolCall,
  type ToolSpec,
} from "./types.js";

const log = createLogger("providers");

/** Comentários de aula são curtos; 4096 sobra (docs/09, seção 2.3). */
export const DEFAULT_MAX_TOKENS = 4096;

const MAX_BODY_CHARS = 500;

/* ------------------------------------------------------------------ */
/* Modelos e preços (skill claude-api, tabela de set/2026)             */
/* ------------------------------------------------------------------ */

interface ModelPricing {
  /** US$ por milhão de tokens de entrada. */
  input: number;
  /** US$ por milhão de tokens de saída. */
  output: number;
  /** US$ por milhão de tokens lidos do cache. Default: 10% da entrada. */
  cacheRead?: number;
}

/** Escrita no cache custa 1,25× a entrada; leitura, 10% (salvo override). */
const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
};

/**
 * Modelos sugeridos do preset `anthropic` (IDs exatos, sem sufixo de data).
 * `listModels()` usa esta tabela para enriquecer o que a API devolve (preço e contexto)
 * e a UI pode listá-la mesmo sem chave configurada.
 */
export const ANTHROPIC_MODELS: ModelInfo[] = [
  model("claude-opus-5", "Claude Opus 5", 1_000_000),
  model("claude-sonnet-5", "Claude Sonnet 5", 1_000_000),
  model("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
  model("claude-opus-4-8", "Claude Opus 4.8", 1_000_000),
  model("claude-fable-5-1", "Claude Fable 5.1", 1_000_000),
];

function model(id: string, name: string, contextLength: number): ModelInfo {
  const price = PRICING[id];
  const info: ModelInfo = { id, name, contextLength, supportsTools: true };
  // `pricing` é em US$ por **token** (mesma unidade do OpenRouter).
  if (price) info.pricing = { prompt: price.input / 1e6, completion: price.output / 1e6 };
  return info;
}

/** Preço do modelo; famílias desconhecidas caem no parente mais próximo (nunca subestimam). */
export function pricingFor(modelId: string): ModelPricing {
  const exact = PRICING[modelId];
  if (exact) return exact;
  const id = modelId.toLowerCase();
  if (id.includes("haiku")) return PRICING["claude-haiku-4-5"];
  if (id.includes("sonnet")) return PRICING["claude-sonnet-4-6"];
  if (id.includes("fable") || id.includes("mythos")) return PRICING["claude-fable-5-1"];
  // Default conservador: um modelo novo desconhecido é cobrado como Opus (nunca de graça,
  // para o limite `maxUsdPerGame` continuar valendo).
  return PRICING["claude-opus-5"];
}

/** Modelos que aceitam `thinking: { type: "adaptive" }` e `output_config.effort`. */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes("haiku")) return false; // Haiku 4.5 ainda usa budget_tokens
  return /(opus|sonnet|fable|mythos)-(4-6|4-7|4-8|5)/.test(id) || /-5-\d/.test(id);
}

/**
 * Modelos que ainda aceitam `temperature`/`top_p`. Nos 4.7+/5 o parâmetro foi removido e
 * a requisição volta 400, então a lista é de **permissão** (o desconhecido não recebe).
 */
export function acceptsSampling(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("haiku") || id.includes("-4-6") || id.includes("-4-5") || id.includes("claude-3");
}

/** Custo estimado em US$ da chamada, contando cache lido e escrito. */
export function estimateCostUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const price = pricingFor(modelId);
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_FACTOR;
  const total =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    (usage.cacheWriteTokens ?? 0) * price.input * CACHE_WRITE_FACTOR +
    (usage.cacheReadTokens ?? 0) * cacheRead;
  return total / 1e6;
}

/* ------------------------------------------------------------------ */
/* Tradução ChatMessage ↔ formato Anthropic                            */
/* ------------------------------------------------------------------ */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export interface AnthropicPayload {
  /** Blocos de system; o último leva `cache_control` (prefixo estável da partida). */
  system?: AnthropicTextBlock[];
  messages: AnthropicMessageParam[];
}

/**
 * Converte a conversa neutra para o formato da Messages API.
 *
 * Regra central: **todos os `tool_result` de uma rodada vão numa única mensagem `user`**
 * (mensagens `tool` consecutivas são fundidas), do mesmo jeito que blocos de texto
 * consecutivos do mesmo papel.
 */
export function toAnthropicMessages(messages: ChatMessage[], cacheSystem = true): AnthropicPayload {
  const systemParts: string[] = [];
  const out: AnthropicMessageParam[] = [];

  const blocksFor = (role: "user" | "assistant"): AnthropicBlock[] => {
    const last = out[out.length - 1];
    if (last && last.role === role) return last.content;
    const created: AnthropicMessageParam = { role, content: [] };
    out.push(created);
    return created.content;
  };

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        if (msg.content.trim()) systemParts.push(msg.content);
        break;
      }
      case "user": {
        if (msg.content.trim()) blocksFor("user").push({ type: "text", text: msg.content });
        break;
      }
      case "assistant": {
        const text = (msg.content ?? "").trim();
        const calls = msg.toolCalls ?? [];
        if (!text && calls.length === 0) break;
        const blocks = blocksFor("assistant");
        if (text) blocks.push({ type: "text", text });
        for (const call of calls) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
        }
        break;
      }
      case "tool": {
        const block: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          // A API recusa conteúdo vazio; o texto das tools nunca é, mas o guard é barato.
          content: msg.content && msg.content.trim() ? msg.content : "(sem conteúdo)",
        };
        if (msg.isError) block.is_error = true;
        blocksFor("user").push(block);
        break;
      }
    }
  }

  // Mensagens que ficaram sem bloco nenhum (texto vazio) quebrariam a requisição.
  const cleaned = out.filter((m) => m.content.length > 0);
  const payload: AnthropicPayload = { messages: cleaned };
  if (systemParts.length) {
    const blocks: AnthropicTextBlock[] = systemParts.map((text) => ({ type: "text", text }));
    if (cacheSystem) blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    payload.system = blocks;
  }
  return payload;
}

/** `ToolSpec` → `Anthropic.Tool` (o JSON Schema vai inteiro em `input_schema`). */
export function toAnthropicTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

interface AnthropicUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessageRaw {
  content?: unknown[];
  stop_reason?: string | null;
  usage?: AnthropicUsageRaw;
  model?: string;
}

function mapStopReason(stop: string | null | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls";
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "other";
  }
}

/** Resposta da Messages API → `ChatResult` (texto, tool calls, custo). */
export function fromAnthropicMessage(raw: AnthropicMessageRaw, modelId: string): ChatResult {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const entry of Array.isArray(raw.content) ? raw.content : []) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
      toolCalls.push({
        id: typeof block.id === "string" && block.id ? block.id : `call_${toolCalls.length + 1}`,
        name: block.name,
        args: input,
        rawArgs: JSON.stringify(input),
      });
    }
    // Blocos `thinking`/`redacted_thinking` não viram texto de aula: são descartados.
  }

  const result: ChatResult = {
    text: texts.join("\n").trim(),
    toolCalls,
    finishReason: mapStopReason(raw.stop_reason, toolCalls.length > 0),
  };

  const u = raw.usage;
  if (u) {
    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const usage: ChatUsage = { inputTokens, outputTokens };
    if (cacheRead) usage.cachedInputTokens = cacheRead;
    usage.costUsd = estimateCostUsd(raw.model ?? modelId, {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });
    result.usage = usage;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Erros                                                               */
/* ------------------------------------------------------------------ */

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (get as (k: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : null;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

/** `retry-after` (segundos ou data HTTP) e `retry-after-ms` → ms. */
export function retryAfterFromHeaders(headers: unknown, now: number): number | undefined {
  const ms = headerValue(headers, "retry-after-ms");
  if (ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const header = headerValue(headers, "retry-after");
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function messageOf(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as Record<string, unknown>;
  const inner = e.error as Record<string, unknown> | undefined;
  const nested = inner?.error as Record<string, unknown> | undefined;
  if (nested && typeof nested.message === "string") return nested.message;
  if (inner && typeof inner.message === "string") return inner.message;
  return typeof e.message === "string" ? e.message : String(err);
}

/**
 * Erro do SDK → `ProviderError` com o que o loop do bot precisa (docs/09, seção 3.5).
 * Mesmo mapeamento do `openai-compat.ts`: 401/402/403/404 param o bot, 408/409/429/5xx e
 * falhas de rede são retentáveis com backoff.
 */
export function toProviderError(err: unknown, providerId: string, apiKeyEnv: string | undefined, now: number): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = (err ?? {}) as Record<string, unknown>;
  const status = typeof e.status === "number" ? e.status : undefined;
  const name = typeof e.name === "string" ? e.name : "";
  const detail = truncate(messageOf(err));

  if (status === undefined) {
    const aborted = /abort/i.test(name) || /timeout/i.test(name) || /timed out/i.test(detail);
    return new ProviderError(aborted ? "Sem resposta do provedor (timeout ou cancelamento)." : `Falha de rede: ${detail}`, {
      providerId,
      retryable: true,
      cause: err,
    });
  }

  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const after = retryAfterFromHeaders(e.headers, now);
  let message: string;
  switch (status) {
    case 401:
    case 403:
      message = `chave de API inválida ou ausente${apiKeyEnv ? ` (${apiKeyEnv})` : ""} — ${detail}`;
      break;
    case 402:
      message = `sem crédito na conta Anthropic — ${detail}`;
      break;
    case 404:
      message = `modelo não encontrado — ${detail}`;
      break;
    case 429:
      message = `limite de requisições atingido — ${detail}`;
      break;
    default:
      message = detail || `HTTP ${status}`;
  }
  return new ProviderError(message, {
    providerId,
    status,
    retryable,
    ...(after !== undefined ? { retryAfterMs: after } : {}),
    body: detail,
    cause: err,
  });
}

/* ------------------------------------------------------------------ */
/* Adaptador                                                           */
/* ------------------------------------------------------------------ */

export interface AnthropicRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Superfície mínima do SDK que usamos. Serve de costura para os testes injetarem um SDK
 * mockado sem rede; em produção é o client real de `@anthropic-ai/sdk`.
 */
export interface AnthropicClientLike {
  messages: {
    create(body: Record<string, unknown>, options?: AnthropicRequestOptions): Promise<AnthropicMessageRaw>;
  };
  models: {
    list(query?: Record<string, unknown>, options?: AnthropicRequestOptions): Promise<{ data?: unknown[] }>;
  };
}

export interface AnthropicOptions {
  /** Chave resolvida pelo registry a partir do ambiente. */
  apiKey?: string;
  now?: () => number;
  /** Testes: SDK já pronto (pula o import dinâmico e a exigência de chave). */
  client?: AnthropicClientLike;
  /** Testes: construtor no lugar do `@anthropic-ai/sdk` (para inspecionar as opções). */
  sdk?: AnthropicSdkConstructor;
}

/** Construtor do client (`new Anthropic({ apiKey, baseURL, timeout, maxRetries })`). */
export type AnthropicSdkConstructor = new (options: {
  apiKey: string;
  maxRetries: number;
  timeout: number;
  baseURL?: string;
}) => unknown;

/** Modelos conhecidos enriquecem o que a API devolve (contexto e preço). */
function enrichModels(list: unknown[]): ModelInfo[] {
  const known = new Map(ANTHROPIC_MODELS.map((m) => [m.id, m]));
  const out: ModelInfo[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    if (!id) continue;
    const base = known.get(id);
    const info: ModelInfo = { id, supportsTools: true };
    const name = typeof e.display_name === "string" ? e.display_name : base?.name;
    if (name) info.name = name;
    const ctx = e.max_input_tokens ?? e.context_window;
    if (typeof ctx === "number" && Number.isFinite(ctx)) info.contextLength = ctx;
    else if (base?.contextLength) info.contextLength = base.contextLength;
    const price = PRICING[id];
    if (price) info.pricing = { prompt: price.input / 1e6, completion: price.output / 1e6 };
    else if (base?.pricing) info.pricing = base.pricing;
    out.push(info);
  }
  return out;
}

export function createAnthropicProvider(cfg: ProviderConfig, opts: AnthropicOptions = {}): ChatProvider {
  const now = opts.now ?? (() => Date.now());
  const timeout = defaultTimeoutMs(cfg);
  let clientPromise: Promise<AnthropicClientLike> | null = null;

  /** Import dinâmico: o pacote só é carregado quando um bot Anthropic realmente joga. */
  const client = async (): Promise<AnthropicClientLike> => {
    if (opts.client) return opts.client;
    if (!clientPromise) {
      clientPromise = (async () => {
        // Gateway local compatível com a Messages API aceita chave vazia: mandamos um valor
        // qualquer, como no adaptador OpenAI-compatível.
        const apiKey = opts.apiKey?.trim() || (isEffectivelyLocal(cfg) ? "local" : "");
        if (!apiKey) {
          throw new ProviderError(
            `Provedor ${cfg.id} sem ${cfg.apiKeyEnv ?? "ANTHROPIC_API_KEY"} no .env`,
            { providerId: cfg.id, status: 401 },
          );
        }
        let Anthropic: AnthropicSdkConstructor;
        if (opts.sdk) {
          Anthropic = opts.sdk;
        } else {
          try {
            const mod = await import("@anthropic-ai/sdk");
            Anthropic = mod.default as unknown as AnthropicSdkConstructor;
          } catch (err) {
            throw new ProviderError(
              "O pacote @anthropic-ai/sdk não está instalado (rode `npm install @anthropic-ai/sdk`).",
              { providerId: cfg.id, cause: err },
            );
          }
        }
        // `maxRetries: 0`: o backoff com jitter é do BotPlayer (docs/09, seção 3.5); dois
        // níveis de retry atrapalhariam o respeito ao `retry-after`.
        const baseURL = cfg.baseUrl?.trim();
        const created = new Anthropic({ apiKey, maxRetries: 0, timeout, ...(baseURL ? { baseURL } : {}) });
        return created as unknown as AnthropicClientLike;
      })().catch((err: unknown) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  };

  const buildBody = (req: ChatRequest): Record<string, unknown> => {
    const { system, messages } = toAnthropicMessages(req.messages);
    const adaptive = supportsAdaptiveThinking(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      // Defaults do plano; `extraBody` do provedor pode sobrescrever.
      ...(adaptive ? { thinking: { type: "adaptive" }, output_config: { effort: "low" } } : {}),
      ...(cfg.extraBody ?? {}),
    };
    if (system) body.system = system;

    // `extraBody` de um preset vale para o provedor inteiro, mas thinking adaptativo e
    // `effort` não existem em todo modelo (Haiku 4.5, modelos antigos): filtra por modelo.
    if (!adaptive) {
      const thinking = body.thinking as { type?: unknown } | undefined;
      if (thinking && thinking.type === "adaptive") delete body.thinking;
      delete body.output_config;
    }
    // Sem `thinking` o modelo responde direto; o `effort` do plano deixa de fazer sentido.
    if (req.thinking === "off") {
      delete body.thinking;
      delete body.output_config;
    }

    if (req.tools?.length) {
      body.tools = toAnthropicTools(req.tools);
      // Nunca `any`/`tool`: forçar tool devolve 400 no Fable 5.1 (docs/09, seção 0).
      body.tool_choice =
        req.toolChoice === "none"
          ? { type: "none" }
          : { type: "auto", disable_parallel_tool_use: !(cfg.parallelToolCalls ?? false) };
    }
    // Amostragem foi removida nos modelos 4.7+/5: mandar `temperature` devolve 400.
    if (req.temperature !== undefined && acceptsSampling(req.model)) body.temperature = req.temperature;
    return body;
  };

  return {
    id: cfg.id,
    kind: "anthropic",
    supportsTools: (cfg.toolMode ?? "native") !== "text",

    async chat(req: ChatRequest): Promise<ChatResult> {
      const sdk = await client();
      const body = buildBody(req);
      let raw: AnthropicMessageRaw;
      try {
        raw = await sdk.messages.create(body, {
          ...(req.signal ? { signal: req.signal } : {}),
          timeout,
        });
      } catch (err) {
        throw toProviderError(err, cfg.id, cfg.apiKeyEnv, now());
      }
      const result = fromAnthropicMessage(raw, req.model);
      if (raw.stop_reason === "refusal") {
        log.warn(`${cfg.id}/${req.model}: a resposta foi recusada por política do modelo (stop_reason: refusal).`);
      }
      if ((process.env.LOG_LEVEL ?? "").toLowerCase() === "debug") result.raw = raw;
      return result;
    },

    async listModels(listOpts?: ListModelsOptions): Promise<ModelInfo[]> {
      const sdk = await client();
      try {
        const page = await sdk.models.list({ limit: 100 }, { timeout: listOpts?.timeoutMs ?? timeout });
        const data = Array.isArray(page?.data) ? page.data : [];
        const models = enrichModels(data);
        return models.length ? models : ANTHROPIC_MODELS;
      } catch (err) {
        throw toProviderError(err, cfg.id, cfg.apiKeyEnv, now());
      }
    },

    async test(): Promise<TestResult> {
      const started = now();
      try {
        const models = await this.listModels({ timeoutMs: MODELS_TIMEOUT_MS });
        return { ok: true, latencyMs: Math.max(0, now() - started), models: models.length };
      } catch (err) {
        return { ok: false, error: err instanceof ProviderError ? err.shortText : (err as Error).message };
      }
    },
  };
}
