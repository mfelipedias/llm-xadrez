/**
 * Abstração neutra de provedor de chat com tool calling (docs/09, seção 2.1).
 * Uma chamada = **uma rodada** de chat: o loop agentic fica no BotPlayer (fase C).
 *
 * Nada aqui conhece xadrez, e nada aqui guarda chave de API: a chave é injetada pelo
 * registry a partir do ambiente e nunca é serializada.
 */
import type { ModelInfo, ProviderKind, ToolMode } from "../../../../shared/types.js";
import { isLocalUrl } from "./net.js";

export type { ModelInfo, ProviderKind, ToolMode };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema dos argumentos (de `z.toJSONSchema`). */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Argumentos como vieram (string JSON), para log/diagnóstico. */
  rawArgs?: string;
  /** Preenchido quando `rawArgs` não pôde ser convertido em objeto. */
  parseError?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Adaptadores ignoram quando o provedor não suporta (Ollama). */
  toolChoice?: "auto" | "none" | { name: string };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

export interface ChatResult {
  /** Texto do assistant (pode ser vazio); já sem blocos `<think>`. */
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: ChatUsage;
  /** Só com LOG_LEVEL=debug; nunca persistido. */
  raw?: unknown;
}

export type TestResult =
  | { ok: true; latencyMs: number; models: number }
  /** `hint`: dica acionável em pt-BR (preenchida pelo diagnóstico do registry). */
  | { ok: false; error: string; hint?: string };

/** Opções de `listModels`: o teste de conexão usa um timeout curto, independente do chat. */
export interface ListModelsOptions {
  timeoutMs?: number;
}

/** Timeout de `GET /models` no teste de conexão e na listagem de modelos. */
export const MODELS_TIMEOUT_MS = 10_000;

export interface ChatProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Capacidade declarada na config, não detectada. */
  readonly supportsTools: boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(opts?: ListModelsOptions): Promise<ModelInfo[]>;
  test(): Promise<TestResult>;
}

/**
 * Configuração de um provedor (`providers.json`). **Nunca** guarda a chave: só o nome da
 * variável de ambiente em `apiKeyEnv`. Ver docs/09, seções 2.2 e 6.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /**
   * Ex.: "https://openrouter.ai/api/v1". No adaptador Anthropic vira o `baseURL` do SDK
   * (gateway/proxy compatível com a Messages API); vazio = api.anthropic.com.
   */
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Provedor local (localhost): sem custo, timeouts maiores, aceita chave vazia. */
  local?: boolean;
  /** Provedor pago: a UI avisa antes de usar. */
  paid?: boolean;
  toolMode?: ToolMode;
  /** false no Ollama (não suporta `tool_choice`). Default: true. */
  toolChoice?: boolean;
  /** Default: false (mandamos `parallel_tool_calls: false` onde é aceito). */
  parallelToolCalls?: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Default: "/models". */
  modelsPath?: string;
  /** Ex.: "supported_parameters=tools" (OpenRouter). */
  modelsQuery?: string;
  /** Default: 60000 (cloud) / 180000 (local). */
  timeoutMs?: number;
  /** Id do preset de origem (informativo; gravado por `POST /api/providers/preset`). */
  preset?: string;
}

/** Erro de provedor com o suficiente para o loop decidir backoff (docs/09, seção 3.5). */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Corpo truncado da resposta (sem cabeçalhos, sem chave). */
  readonly body?: string;

  constructor(
    message: string,
    opts: { providerId: string; status?: number; retryable?: boolean; retryAfterMs?: number; body?: string; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.providerId = opts.providerId;
    if (opts.status !== undefined) this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.body !== undefined) this.body = opts.body;
  }

  /** Texto curto e seguro para o feed/UI (sem corpo bruto). */
  get shortText(): string {
    return this.status ? `${this.status}: ${this.message}` : this.message;
  }
}

/**
 * O provedor é local? `local` explícito na config vence; sem ele, infere pela baseUrl
 * (localhost ou rede local: 10/8, 172.16/12, 192.168/16, 100.64/10, *.local,
 * host.docker.internal...). Local = sem chave obrigatória, timeout longo e
 * `Authorization: Bearer local` quando não há chave. Única fonte da regra: use sempre esta.
 */
export function isEffectivelyLocal(cfg: Pick<ProviderConfig, "local" | "baseUrl">): boolean {
  return cfg.local ?? isLocalUrl(cfg.baseUrl);
}

/** Timeout default por requisição, conforme o provedor seja local ou remoto. */
export function defaultTimeoutMs(cfg: ProviderConfig): number {
  return cfg.timeoutMs ?? (isEffectivelyLocal(cfg) ? 180_000 : 60_000);
}
