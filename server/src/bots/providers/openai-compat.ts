/**
 * Adaptador OpenAI-compatível (docs/09, seção 2.2) com `fetch` nativo, sem dependências:
 * cobre OpenRouter, LiteLLM, Ollama (/v1), LM Studio, llama.cpp, vLLM, Jan e gateways custom.
 *
 * As diferenças entre provedores são resolvidas por **flags da config** (`toolChoice`,
 * `parallelToolCalls`, `extraHeaders`, `extraBody`, `modelsPath`...), nunca por detecção.
 * O que varia na resposta é tratado com parsing tolerante:
 *  - `function.arguments` string JSON, objeto já parseado ou JSON quebrado (extrai o 1º `{...}`);
 *  - `id` ausente na tool call → gera `call_<n>`;
 *  - `<think>…</think>` de modelos com reasoning → removido do texto;
 *  - `content` como array de blocos → concatena os blocos de texto.
 */
import type { ModelInfo } from "../../../../shared/types.js";
import { createLogger } from "../../log.js";
import {
  MODELS_TIMEOUT_MS,
  ProviderError,
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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatOptions {
  /** Chave resolvida pelo registry (nunca vem de `providers.json`). */
  apiKey?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

const MAX_BODY_CHARS = 500;

/* ------------------------------------------------------------------ */
/* Helpers exportados (testados diretamente)                           */
/* ------------------------------------------------------------------ */

/** Remove blocos de raciocínio (`<think>`, `<thinking>`), inclusive não fechados. */
export function stripThink(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, "")
    .trim();
}

/** Primeiro objeto `{...}` balanceado do texto (fallback para JSON sujo/com prosa em volta). */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse tolerante dos argumentos de uma tool call. Nunca lança. */
export function parseToolArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw === null || raw === undefined || raw === "") return { args: {} };
  if (typeof raw === "object") return { args: raw as Record<string, unknown> };
  if (typeof raw !== "string") return { args: {}, error: `tipo inesperado: ${typeof raw}` };
  const text = raw.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
    return { args: {}, error: "os argumentos não são um objeto JSON" };
  } catch {
    /* tenta extrair o primeiro objeto balanceado */
  }
  const candidate = firstJsonObject(text);
  if (candidate) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
    } catch {
      /* cai no erro abaixo */
    }
  }
  return { args: {}, error: "JSON inválido nos argumentos da tool" };
}

/** `retry-after` em segundos ou data HTTP → ms. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    }
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) },
        }));
      }
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

function mapTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function mapFinishReason(raw: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls";
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "other";
  }
}

function parseUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const usage: ChatUsage = {
    inputTokens: num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0,
    outputTokens: num(u.completion_tokens) ?? num(u.output_tokens) ?? 0,
  };
  const cached = num(details.cached_tokens);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  // OpenRouter devolve o custo em USD quando `usage: { include: true }` vai no body.
  const cost = num(u.cost) ?? num((u.cost_details as Record<string, unknown> | undefined)?.upstream_inference_cost);
  if (cost !== undefined) usage.costUsd = cost;
  return usage;
}

function parseToolCalls(rawCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawCalls)) return [];
  const calls: ToolCall[] = [];
  rawCalls.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const fn = (e.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : typeof e.name === "string" ? e.name : "";
    if (!name) return;
    const rawArgs = fn.arguments ?? (e as { arguments?: unknown }).arguments;
    const { args, error } = parseToolArgs(rawArgs);
    // Servidores locais às vezes omitem o id: o protocolo exige um para casar o tool result.
    const call: ToolCall = { id: typeof e.id === "string" && e.id ? e.id : `call_${index + 1}`, name, args };
    if (typeof rawArgs === "string") call.rawArgs = rawArgs;
    else if (rawArgs !== undefined) call.rawArgs = JSON.stringify(rawArgs);
    if (error) call.parseError = error;
    calls.push(call);
  });
  return calls;
}

/** Normaliza `/v1/models` (OpenAI), `/api/tags` (Ollama nativo) e `/api/v0/models` (LM Studio). */
export function parseModels(json: unknown): ModelInfo[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const out: ModelInfo[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push({ id: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : typeof e.name === "string" ? e.name : typeof e.model === "string" ? e.model : "";
    if (!id) continue;
    const info: ModelInfo = { id };
    if (typeof e.name === "string" && e.name !== id) info.name = e.name;
    const ctx = e.context_length ?? e.max_context_length ?? e.context_window ?? e.loaded_context_length;
    if (typeof ctx === "number" && Number.isFinite(ctx)) info.contextLength = ctx;
    if (Array.isArray(e.supported_parameters)) {
      info.supportsTools = (e.supported_parameters as unknown[]).includes("tools");
    }
    const pricing = e.pricing as Record<string, unknown> | undefined;
    if (pricing && typeof pricing === "object") {
      const prompt = Number(pricing.prompt);
      const completion = Number(pricing.completion);
      const p: { prompt?: number; completion?: number } = {};
      if (Number.isFinite(prompt)) p.prompt = prompt;
      if (Number.isFinite(completion)) p.completion = completion;
      if (p.prompt !== undefined || p.completion !== undefined) info.pricing = p;
    }
    out.push(info);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Adaptador                                                           */
/* ------------------------------------------------------------------ */

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

export function createOpenAiCompatProvider(cfg: ProviderConfig, opts: OpenAiCompatOptions = {}): ChatProvider {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const timeout = defaultTimeoutMs(cfg);
  const baseUrl = cfg.baseUrl ?? "";
  const local = isEffectivelyLocal(cfg);

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json", ...(cfg.extraHeaders ?? {}) };
    // Ollama exige um valor qualquer de Authorization; LM Studio/llama.cpp ignoram.
    const key = opts.apiKey?.trim() || (local ? "local" : "");
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  };

  const requestSignal = (ms: number, external?: AbortSignal): AbortSignal => {
    const timer = AbortSignal.timeout(ms);
    return external ? AbortSignal.any([external, timer]) : timer;
  };

  const call = async (path: string, init: RequestInit & { signal?: AbortSignal }, timeoutMs = timeout): Promise<unknown> => {
    if (!baseUrl) {
      throw new ProviderError(`Provedor "${cfg.id}" sem baseUrl configurada.`, { providerId: cfg.id });
    }
    const url = joinUrl(baseUrl, path);
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers: headers() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      // `fetch failed` sozinho não diz nada: o código do sistema (ECONNREFUSED...) vem na causa.
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      const detail = typeof code === "string" && code ? `${message} (${code})` : message;
      throw new ProviderError(
        aborted ? `Sem resposta em ${Math.round(timeoutMs / 1000)} s (timeout).` : `Falha de rede: ${detail}`,
        { providerId: cfg.id, retryable: true, cause: err },
      );
    }
    if (!res.ok) {
      const body = truncate(await res.text().catch(() => ""));
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      const after = retryAfterMs(res.headers.get("retry-after"), now());
      throw new ProviderError(explainStatus(res.status, body), {
        providerId: cfg.id,
        status: res.status,
        retryable,
        ...(after !== undefined ? { retryAfterMs: after } : {}),
        body,
      });
    }
    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new ProviderError("Resposta não é JSON válido.", { providerId: cfg.id, retryable: true, cause: err });
    }
  };

  const explainStatus = (status: number, body: string): string => {
    const detail = extractErrorMessage(body);
    switch (status) {
      case 401:
      case 403:
        return `chave de API inválida ou ausente${cfg.apiKeyEnv ? ` (${cfg.apiKeyEnv})` : ""}${detail ? ` — ${detail}` : ""}`;
      case 402:
        return `sem crédito no provedor${detail ? ` — ${detail}` : ""}`;
      case 404:
        return `modelo ou endpoint não encontrado${detail ? ` — ${detail}` : ""}`;
      case 429:
        return `limite de requisições atingido${detail ? ` — ${detail}` : ""}`;
      default:
        return detail || `HTTP ${status}`;
    }
  };

  return {
    id: cfg.id,
    kind: "openai",
    supportsTools: (cfg.toolMode ?? "native") !== "text",

    async chat(req: ChatRequest): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: mapMessages(req.messages),
        ...(cfg.extraBody ?? {}),
      };
      if (req.tools?.length) {
        body.tools = mapTools(req.tools);
        if (cfg.toolChoice !== false && req.toolChoice) {
          body.tool_choice =
            typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", function: { name: req.toolChoice.name } };
        }
        // Provedores locais costumam rejeitar campos desconhecidos: só mandamos fora deles.
        if (!local) body.parallel_tool_calls = cfg.parallelToolCalls ?? false;
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const json = await call("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
        signal: requestSignal(timeout, req.signal),
      });

      const root = (json ?? {}) as Record<string, unknown>;
      const choice = (Array.isArray(root.choices) ? root.choices[0] : undefined) as Record<string, unknown> | undefined;
      const message = (choice?.message ?? {}) as Record<string, unknown>;
      const toolCalls = parseToolCalls(message.tool_calls);
      const result: ChatResult = {
        text: stripThink(textFromContent(message.content)),
        toolCalls,
        finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
      };
      const usage = parseUsage(root.usage);
      if (usage) result.usage = usage;
      if ((process.env.LOG_LEVEL ?? "").toLowerCase() === "debug") result.raw = json;
      for (const c of toolCalls) {
        if (c.parseError) log.debug(`${cfg.id}: argumentos de ${c.name} ilegíveis (${c.parseError})`);
      }
      return result;
    },

    async listModels(listOpts?: ListModelsOptions): Promise<ModelInfo[]> {
      const path = cfg.modelsPath ?? "/models";
      const query = cfg.modelsQuery ? `?${cfg.modelsQuery.replace(/^\?/, "")}` : "";
      const ms = listOpts?.timeoutMs ?? timeout;
      const json = await call(`${path}${query}`, { method: "GET", signal: requestSignal(ms) }, ms);
      return parseModels(json);
    },

    async test(): Promise<TestResult> {
      const started = now();
      try {
        const models = await this.listModels({ timeoutMs: MODELS_TIMEOUT_MS });
        return { ok: true, latencyMs: Math.max(0, now() - started), models: models.length };
      } catch (err) {
        const message = err instanceof ProviderError ? err.shortText : err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  };
}

/** Mensagem de erro do corpo, sem vazar o corpo inteiro. */
function extractErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === "string") return truncate(err);
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      return truncate((err as { message: string }).message);
    }
    if (typeof parsed.message === "string") return truncate(parsed.message);
  } catch {
    /* corpo não-JSON */
  }
  return truncate(body.replace(/\s+/g, " ").trim());
}
