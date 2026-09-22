/**
 * Adaptador Anthropic (docs/09, fase F) com o **SDK mockado**: nenhuma chamada de rede,
 * nenhum custo. O caso central é o do plano: blocos `tool_use` do modelo voltam como
 * `tool_result` numa **única** mensagem `user`.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MODELS,
  createAnthropicProvider,
  estimateCostUsd,
  toAnthropicMessages,
  type AnthropicClientLike,
  type AnthropicMessageRaw,
} from "../src/bots/providers/anthropic.js";
import { PRESETS, ProviderRegistry } from "../src/bots/providers/registry.js";
import { ProviderError, type ChatRequest, type ProviderConfig } from "../src/bots/providers/types.js";

function anthropicCfg(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return { ...(PRESETS.anthropic as ProviderConfig), ...patch };
}

/** SDK mockado: guarda os corpos enviados e devolve respostas scriptadas. */
function mockSdk(
  replies: (AnthropicMessageRaw | Error)[],
  models: unknown[] = [],
): { client: AnthropicClientLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const client: AnthropicClientLike = {
    messages: {
      create(body) {
        bodies.push(body);
        const reply = replies[Math.min(index++, replies.length - 1)];
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(reply);
      },
    },
    models: {
      list() {
        return Promise.resolve({ data: models });
      },
    },
  };
  return { client, bodies };
}

/** Resposta da Messages API: bloco de raciocínio vazio + texto + `tool_use`. */
const TOOL_USE_REPLY: AnthropicMessageRaw = {
  model: "claude-opus-5",
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: "Vou disputar o centro." },
    { type: "tool_use", id: "toolu_01A", name: "make_move", input: { move: "e5", comment: "Simetria no centro." } },
  ],
  usage: { input_tokens: 2100, output_tokens: 120, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 },
};

function sdkError(status: number, message: string, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), {
    status,
    name: status === 429 ? "RateLimitError" : "APIError",
    ...(headers ? { headers: new Headers(headers) } : {}),
    error: { type: "error", error: { type: "api_error", message } },
  });
}

/* ------------------------------------------------------------------ */
/* Tradução de mensagens                                               */
/* ------------------------------------------------------------------ */

describe("anthropic — tradução de mensagens", () => {
  it("system vira bloco de texto com cache_control ephemeral", () => {
    const payload = toAnthropicMessages([
      { role: "system", content: "Você é professor de xadrez." },
      { role: "user", content: "É sua vez." },
    ]);
    expect(payload.system).toEqual([
      { type: "text", text: "Você é professor de xadrez.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages).toEqual([{ role: "user", content: [{ type: "text", text: "É sua vez." }] }]);
  });

  it("tool_use do modelo volta como tool_result numa ÚNICA mensagem user", () => {
    const payload = toAnthropicMessages([
      { role: "system", content: "prompt" },
      { role: "user", content: "É sua vez." },
      {
        role: "assistant",
        content: "Jogo e comento.",
        toolCalls: [
          { id: "toolu_1", name: "make_move", args: { move: "e5" } },
          { id: "toolu_2", name: "highlight", args: { arrows: ["e7-e5"] } },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", name: "make_move", content: "Lance aplicado: e5" },
      { role: "tool", toolCallId: "toolu_2", name: "highlight", content: "Seta desenhada" },
      { role: "user", content: "O oponente jogou Nf3." },
    ]);

    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Jogo e comento." },
        { type: "tool_use", id: "toolu_1", name: "make_move", input: { move: "e5" } },
        { type: "tool_use", id: "toolu_2", name: "highlight", input: { arrows: ["e7-e5"] } },
      ],
    });
    // Os dois resultados (e o que o humano disse depois) cabem na MESMA mensagem `user`.
    expect(payload.messages[2].role).toBe("user");
    expect(payload.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "Lance aplicado: e5" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "Seta desenhada" },
      { type: "text", text: "O oponente jogou Nf3." },
    ]);
  });

  it("tool result com erro leva is_error; conteúdo vazio não vira bloco inválido", () => {
    const payload = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "make_move", args: { move: "Qh9" } }] },
      { role: "tool", toolCallId: "t1", name: "make_move", content: "Lance ilegal.", isError: true },
      { role: "tool", toolCallId: "t2", name: "comment", content: "   " },
      { role: "assistant", content: "   " },
    ]);
    expect(payload.messages[0].content).toEqual([
      { type: "tool_use", id: "t1", name: "make_move", input: { move: "Qh9" } },
    ]);
    expect(payload.messages[1].content[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(payload.messages[1].content[1]).toMatchObject({ content: "(sem conteúdo)" });
    // A mensagem de assistant só com espaços sumiu em vez de virar conteúdo vazio.
    expect(payload.messages).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* chat()                                                              */
/* ------------------------------------------------------------------ */

describe("anthropic — chat()", () => {
  const request = (patch: Partial<ChatRequest> = {}): ChatRequest => ({
    model: "claude-opus-5",
    messages: [
      { role: "system", content: "prompt estável" },
      { role: "user", content: "É sua vez." },
    ],
    tools: [{ name: "make_move", description: "Joga um lance", parameters: { type: "object", properties: {} } }],
    toolChoice: "auto",
    ...patch,
  });

  it("monta o corpo com cache no system, thinking adaptativo, effort low e tool_choice auto", async () => {
    const { client, bodies } = mockSdk([TOOL_USE_REPLY]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    await provider.chat(request({ temperature: 0.7 }));

    const body = bodies[0];
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(4096);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.system).toEqual([{ type: "text", text: "prompt estável", cache_control: { type: "ephemeral" } }]);
    expect(body.tools).toEqual([
      { name: "make_move", description: "Joga um lance", input_schema: { type: "object", properties: {} } },
    ]);
    // Nunca `any`/`tool`: forçar tool devolve 400 no Fable 5.1.
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    // Amostragem foi removida nos modelos 4.7+/5: mandar `temperature` devolveria 400.
    expect(body).not.toHaveProperty("temperature");
  });

  it("descarta thinking/effort e mantém temperature nos modelos que aceitam amostragem", async () => {
    const { client, bodies } = mockSdk([TOOL_USE_REPLY]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    await provider.chat(request({ model: "claude-haiku-4-5", temperature: 0.3 }));

    const body = bodies[0];
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body.temperature).toBe(0.3);
  });

  it("traduz tool_use, uso e custo (incluindo tokens lidos do cache)", async () => {
    const { client } = mockSdk([TOOL_USE_REPLY]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const res = await provider.chat(request());

    expect(res.finishReason).toBe("tool_calls");
    expect(res.text).toBe("Vou disputar o centro.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({ id: "toolu_01A", name: "make_move" });
    expect(res.toolCalls[0].args).toEqual({ move: "e5", comment: "Simetria no centro." });
    expect(res.usage?.inputTokens).toBe(2100);
    expect(res.usage?.outputTokens).toBe(120);
    expect(res.usage?.cachedInputTokens).toBe(1800);
    // (2100×$5 + 120×$25 + 1800×$0,50) por MTok — leitura de cache custa 10% da entrada.
    expect(res.usage?.costUsd).toBeCloseTo((2100 * 5 + 120 * 25 + 1800 * 0.5) / 1e6, 10);
  });

  it("resposta só de texto vira finishReason stop", async () => {
    const { client } = mockSdk([{ stop_reason: "end_turn", content: [{ type: "text", text: "Boa pergunta!" }] }]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const res = await provider.chat(request());
    expect(res.finishReason).toBe("stop");
    expect(res.text).toBe("Boa pergunta!");
    expect(res.toolCalls).toEqual([]);
  });

  it("a rodada seguinte reenvia o tool_result numa única mensagem user", async () => {
    const { client, bodies } = mockSdk([TOOL_USE_REPLY]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    await provider.chat(
      request({
        messages: [
          { role: "system", content: "prompt estável" },
          { role: "user", content: "É sua vez." },
          { role: "assistant", content: "", toolCalls: [{ id: "toolu_01A", name: "make_move", args: { move: "e5" } }] },
          { role: "tool", toolCallId: "toolu_01A", name: "make_move", content: "ok" },
        ],
      }),
    );
    const messages = bodies[0].messages as { role: string; content: unknown[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_01A", content: "ok" }]);
  });
});

/* ------------------------------------------------------------------ */
/* Erros                                                               */
/* ------------------------------------------------------------------ */

describe("anthropic — erros viram ProviderError", () => {
  const req: ChatRequest = { model: "claude-opus-5", messages: [{ role: "user", content: "oi" }] };

  it("429 é retentável e respeita retry-after", async () => {
    const { client } = mockSdk([sdkError(429, "rate limited", { "retry-after": "3" })]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const err = (await provider.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
  });

  it("401 não é retentável e cita a variável de ambiente", async () => {
    const { client } = mockSdk([sdkError(401, "invalid x-api-key")]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const err = (await provider.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.shortText).toContain("ANTHROPIC_API_KEY");
  });

  it("404 (modelo inexistente) para o bot; 500 é retentável", async () => {
    const notFound = mockSdk([sdkError(404, "model: claude-opus-42")]);
    const p1 = createAnthropicProvider(anthropicCfg(), { client: notFound.client });
    const e1 = (await p1.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(e1.status).toBe(404);
    expect(e1.retryable).toBe(false);
    expect(e1.message).toContain("modelo não encontrado");

    const boom = mockSdk([sdkError(529, "overloaded")]);
    const p2 = createAnthropicProvider(anthropicCfg(), { client: boom.client });
    const e2 = (await p2.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(e2.retryable).toBe(true);
  });

  it("falha de rede (sem status) é retentável", async () => {
    const { client } = mockSdk([Object.assign(new Error("fetch failed"), { name: "APIConnectionError" })]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const err = (await provider.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(err.status).toBeUndefined();
    expect(err.retryable).toBe(true);
  });

  it("sem chave no ambiente, o teste de conexão falha citando o .env", async () => {
    const provider = createAnthropicProvider(anthropicCfg());
    const result = await provider.test();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ANTHROPIC_API_KEY");
  });
});

/* ------------------------------------------------------------------ */
/* Modelos, preços e registry                                          */
/* ------------------------------------------------------------------ */

describe("anthropic — modelos, preços e registry", () => {
  it("listModels enriquece o que a API devolve com contexto e preço", async () => {
    const { client } = mockSdk([TOOL_USE_REPLY], [{ id: "claude-opus-5", display_name: "Claude Opus 5" }]);
    const provider = createAnthropicProvider(anthropicCfg(), { client });
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({ id: "claude-opus-5", name: "Claude Opus 5", supportsTools: true });
    expect(models[0].pricing?.prompt).toBeCloseTo(5 / 1e6, 12);
    expect(models[0].contextLength).toBe(1_000_000);
    expect(await provider.test()).toMatchObject({ ok: true, models: 1 });
  });

  it("modelo desconhecido é cobrado pela família (nunca de graça)", () => {
    expect(estimateCostUsd("claude-opus-5", { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(5, 10);
    expect(estimateCostUsd("claude-haiku-9", { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(1, 10);
    expect(estimateCostUsd("modelo-novo-sem-tabela", { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(5, 10);
    // Escrita no cache custa 1,25× a entrada.
    expect(estimateCostUsd("claude-opus-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1e6 })).toBeCloseTo(6.25, 10);
  });

  it("o preset anthropic traz os modelos atuais", () => {
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toContain("claude-opus-5");
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toContain("claude-sonnet-5");
    expect(ANTHROPIC_MODELS.every((m) => m.supportsTools)).toBe(true);
    expect(PRESETS.anthropic.kind).toBe("anthropic");
    expect(PRESETS.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(PRESETS.anthropic.paid).toBe(true);
  });

  it("o registry instancia o adaptador Anthropic (não lança mais 'fase F')", () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    const provider = registry.provider("anthropic");
    expect(provider.kind).toBe("anthropic");
    expect(provider.supportsTools).toBe(true);
    // Sem chave no ambiente: o registry avisa, mas o provedor existe.
    expect(registry.missingKeyReason("anthropic")).toContain("ANTHROPIC_API_KEY");
  });
});
