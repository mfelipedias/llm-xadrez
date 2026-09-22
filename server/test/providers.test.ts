/**
 * Camada de provedores (docs/09, fase B): adaptador OpenAI-compatível com `fetch` mockado
 * usando respostas reais de OpenRouter, Ollama e LM Studio, e o registry (presets, máscara
 * de chave, providers.json sem segredos).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenAiCompatProvider,
  firstJsonObject,
  parseModels,
  parseToolArgs,
  retryAfterMs,
  stripThink,
} from "../src/bots/providers/openai-compat.js";
import { PRESET_IDS, PRESETS, ProviderRegistry, maskKey } from "../src/bots/providers/registry.js";
import { createFakeProvider } from "../src/bots/providers/fake.js";
import { ProviderError, type ChatRequest, type ProviderConfig } from "../src/bots/providers/types.js";
import { redact } from "../src/log.js";

/* ------------------------------------------------------------------ */
/* Fixtures (formatos reais, docs/09 seção 0)                          */
/* ------------------------------------------------------------------ */

/** OpenRouter: tool_calls com id, `arguments` string JSON, usage com custo. */
const OPENROUTER_TOOL_CALL = {
  id: "gen-1758501234-abc",
  provider: "Anthropic",
  model: "anthropic/claude-sonnet-4.6",
  object: "chat.completion",
  created: 1758501234,
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            index: 0,
            id: "toolu_01Abc",
            type: "function",
            function: {
              name: "make_move",
              arguments: '{"move": "e5", "comment": "Disputo o centro com simetria."}',
            },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 1843,
    completion_tokens: 96,
    total_tokens: 1939,
    prompt_tokens_details: { cached_tokens: 1536 },
    cost: 0.0042,
  },
};

/** Ollama /v1: sem `id` na tool call, `arguments` já como objeto e `<think>` no content. */
const OLLAMA_TOOL_CALL = {
  id: "chatcmpl-742",
  object: "chat.completion",
  created: 1758501300,
  model: "qwen3:8b",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "<think>\nPreciso escolher um lance da lista. Nf3 desenvolve.\n</think>\nVou desenvolver o cavalo.",
        tool_calls: [{ type: "function", function: { name: "make_move", arguments: { move: "Nf3" } } }],
      },
    },
  ],
  usage: { prompt_tokens: 980, completion_tokens: 140, total_tokens: 1120 },
};

/** LM Studio: modelo sem tools devolve texto (cai no modo texto estruturado, fase D). */
const LMSTUDIO_TEXT = {
  id: "chatcmpl-9f1",
  object: "chat.completion",
  created: 1758501400,
  model: "qwen3-8b",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "MOVE: e4\nCOMMENT: Ocupo o centro." },
    },
  ],
  usage: { prompt_tokens: 700, completion_tokens: 25, total_tokens: 725 },
};

const LMSTUDIO_MODELS = {
  object: "list",
  data: [
    { id: "qwen3-8b", object: "model", owned_by: "organization_owner" },
    { id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "organization_owner" },
  ],
};

const OPENROUTER_MODELS = {
  data: [
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Anthropic: Claude Sonnet 4.6",
      context_length: 200000,
      supported_parameters: ["tools", "tool_choice", "temperature"],
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
    {
      id: "deepseek/deepseek-chat-v3-0324",
      name: "DeepSeek V3",
      context_length: 163840,
      supported_parameters: ["tools", "temperature"],
      pricing: { prompt: "0.00000027", completion: "0.0000011" },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface Recorded {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetch(responses: (Response | (() => Response))[]): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url: string, init: RequestInit = {}) => {
      const raw = typeof init.body === "string" ? init.body : "";
      calls.push({ url, init, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const next = responses[Math.min(index++, responses.length - 1)];
      return typeof next === "function" ? next() : next;
    },
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const baseRequest: ChatRequest = {
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "system", content: "Você é professora de xadrez." },
    { role: "user", content: "É sua vez. Lances legais (é a sua vez; 20): e4 d4 Nf3" },
  ],
  tools: [{ name: "make_move", description: "Joga um lance", parameters: { type: "object", properties: {} } }],
  toolChoice: "auto",
};

const openrouterCfg: ProviderConfig = { ...PRESETS.openrouter };
const ollamaCfg: ProviderConfig = { ...PRESETS.ollama };
const lmstudioCfg: ProviderConfig = { ...PRESETS.lmstudio };

/* ------------------------------------------------------------------ */
/* Helpers de parsing                                                  */
/* ------------------------------------------------------------------ */

describe("openai-compat — parsing tolerante", () => {
  it("stripThink remove blocos de raciocínio (fechados, abertos e só o fecho)", () => {
    expect(stripThink("<think>bla bla</think>\nMOVE: e4")).toBe("MOVE: e4");
    expect(stripThink("<thinking>raciocínio sem fim...")).toBe("");
    expect(stripThink("sobra do raciocínio</think>resposta")).toBe("resposta");
    expect(stripThink("texto normal")).toBe("texto normal");
  });

  it("parseToolArgs aceita string JSON, objeto, JSON com prosa em volta e sinaliza lixo", () => {
    expect(parseToolArgs('{"move":"e5"}').args).toEqual({ move: "e5" });
    expect(parseToolArgs({ move: "Nf3" }).args).toEqual({ move: "Nf3" });
    expect(parseToolArgs('Claro! {"move":"e5","comment":"vou de e5"} pronto.').args).toEqual({
      move: "e5",
      comment: "vou de e5",
    });
    expect(parseToolArgs("").args).toEqual({});
    const broken = parseToolArgs("move = e5");
    expect(broken.args).toEqual({});
    expect(broken.error).toMatch(/JSON inválido/);
  });

  it("firstJsonObject ignora chaves dentro de strings", () => {
    expect(firstJsonObject('lixo {"c":"a } b"} fim')).toBe('{"c":"a } b"}');
    expect(firstJsonObject("sem objeto")).toBeNull();
  });

  it("retryAfterMs entende segundos e data HTTP", () => {
    const now = Date.parse("2026-09-22T10:00:00.000Z");
    expect(retryAfterMs("4", now)).toBe(4000);
    expect(retryAfterMs("Tue, 22 Sep 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("qualquer coisa", now)).toBeUndefined();
  });

  it("parseModels normaliza OpenRouter, LM Studio e /api/tags do Ollama", () => {
    const or = parseModels(OPENROUTER_MODELS);
    expect(or[0]).toMatchObject({ id: "anthropic/claude-sonnet-4.6", supportsTools: true, contextLength: 200000 });
    expect(or[0].pricing?.prompt).toBeCloseTo(0.000003);
    expect(parseModels(LMSTUDIO_MODELS).map((m) => m.id)).toEqual([
      "qwen3-8b",
      "text-embedding-nomic-embed-text-v1.5",
    ]);
    expect(parseModels({ models: [{ name: "llama3.1:8b", size: 4661224676 }] })).toEqual([{ id: "llama3.1:8b" }]);
    expect(parseModels(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* chat()                                                             */
/* ------------------------------------------------------------------ */

describe("openai-compat — chat()", () => {
  it("OpenRouter: tool call com arguments string, usage com custo e headers/extraBody do preset", async () => {
    const { fetchImpl, calls } = mockFetch([json(OPENROUTER_TOOL_CALL)]);
    const provider = createOpenAiCompatProvider(openrouterCfg, { fetchImpl, apiKey: "sk-or-v1-segredo-1234" });
    const res = await provider.chat(baseRequest);

    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({ id: "toolu_01Abc", name: "make_move" });
    expect(res.toolCalls[0].args).toEqual({ move: "e5", comment: "Disputo o centro com simetria." });
    expect(res.usage).toEqual({ inputTokens: 1843, outputTokens: 96, cachedInputTokens: 1536, costUsd: 0.0042 });

    const [call] = calls;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-v1-segredo-1234");
    expect(headers["X-Title"]).toBe("LLM Xadrez");
    expect(call.body.tool_choice).toBe("auto");
    expect(call.body.parallel_tool_calls).toBe(false);
    expect(call.body.usage).toEqual({ include: true });
    expect((call.body.tools as { function: { name: string } }[])[0].function.name).toBe("make_move");
  });

  it("Ollama: tool call sem id e com arguments objeto; <think> some do texto; sem tool_choice", async () => {
    const { fetchImpl, calls } = mockFetch([json(OLLAMA_TOOL_CALL)]);
    const provider = createOpenAiCompatProvider(ollamaCfg, { fetchImpl });
    const res = await provider.chat({ ...baseRequest, model: "qwen3:8b" });

    expect(res.toolCalls[0]).toMatchObject({ id: "call_1", name: "make_move" });
    expect(res.toolCalls[0].args).toEqual({ move: "Nf3" });
    expect(res.text).toBe("Vou desenvolver o cavalo.");
    expect(res.usage).toEqual({ inputTokens: 980, outputTokens: 140 });

    const [call] = calls;
    expect(call.url).toBe("http://localhost:11434/v1/chat/completions");
    // toolChoice: false no preset => nada de tool_choice; local => nada de parallel_tool_calls.
    expect(call.body.tool_choice).toBeUndefined();
    expect(call.body.parallel_tool_calls).toBeUndefined();
    // Ollama exige um Authorization qualquer.
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer local");
  });

  it("LM Studio: resposta só de texto vira finishReason stop com toolCalls vazio", async () => {
    const { fetchImpl } = mockFetch([json(LMSTUDIO_TEXT)]);
    const provider = createOpenAiCompatProvider(lmstudioCfg, { fetchImpl });
    const res = await provider.chat({ ...baseRequest, model: "qwen3-8b" });
    expect(res.toolCalls).toEqual([]);
    expect(res.finishReason).toBe("stop");
    expect(res.text).toBe("MOVE: e4\nCOMMENT: Ocupo o centro.");
  });

  it("429 com retry-after vira ProviderError retentável", async () => {
    const { fetchImpl } = mockFetch([
      () =>
        new Response(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), {
          status: 429,
          headers: { "retry-after": "4", "content-type": "application/json" },
        }),
    ]);
    const now = Date.parse("2026-09-22T10:00:00.000Z");
    const provider = createOpenAiCompatProvider(openrouterCfg, { fetchImpl, apiKey: "sk-or-v1-x", now: () => now });
    const err = (await provider.chat(baseRequest).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(4000);
    expect(err.message).toContain("limite de requisições");
  });

  it("401 não é retentável e cita a variável de ambiente esperada", async () => {
    const { fetchImpl } = mockFetch([
      () =>
        new Response(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const provider = createOpenAiCompatProvider(openrouterCfg, { fetchImpl });
    const err = (await provider.chat(baseRequest).catch((e: unknown) => e)) as ProviderError;
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.shortText).toContain("OPENROUTER_API_KEY");
    expect(err.shortText).toContain("No auth credentials found");
  });

  it("erro de rede vira ProviderError retentável, sem vazar a chave", async () => {
    const provider = createOpenAiCompatProvider(openrouterCfg, {
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1234")),
      apiKey: "sk-or-v1-segredo",
    });
    const err = (await provider.chat(baseRequest).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Falha de rede");
    expect(JSON.stringify(err)).not.toContain("segredo");
  });

  it("mensagens assistant/tool são mapeadas para o formato OpenAI", async () => {
    const { fetchImpl, calls } = mockFetch([json(LMSTUDIO_TEXT)]);
    const provider = createOpenAiCompatProvider(lmstudioCfg, { fetchImpl });
    await provider.chat({
      model: "qwen3-8b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "vez" },
        { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "make_move", args: { move: "e4" } }] },
        { role: "tool", toolCallId: "c1", name: "make_move", content: "Você jogou 1. e4.", isError: false },
      ],
    });
    const messages = calls[0].body.messages as Record<string, unknown>[];
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "make_move", arguments: '{"move":"e4"}' } }],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", name: "make_move", content: "Você jogou 1. e4." });
  });

  it("listModels e test() usam modelsPath/modelsQuery do preset", async () => {
    const { fetchImpl, calls } = mockFetch([json(OPENROUTER_MODELS)]);
    let clock = 1000;
    const provider = createOpenAiCompatProvider(openrouterCfg, {
      fetchImpl,
      apiKey: "sk-or-v1-x",
      now: () => (clock += 50),
    });
    const result = await provider.test();
    expect(result).toMatchObject({ ok: true, models: 2 });
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/models?supported_parameters=tools");
  });
});

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const tmpFiles: string[] = [];

function tmpPath(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-xadrez-")), "providers.json");
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  while (tmpFiles.length) {
    const file = tmpFiles.pop() as string;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe("ProviderRegistry", () => {
  it("sem providers.json usa os presets embutidos", () => {
    const registry = new ProviderRegistry({ env: {} });
    expect(registry.list().map((p) => p.id)).toEqual(["openrouter", "anthropic", "lmstudio", "ollama"]);
    expect(PRESET_IDS).toContain("llamacpp");
  });

  it("lê o providers.json do repositório (presets sem chaves)", () => {
    const repoFile = path.resolve(import.meta.dirname, "..", "..", "providers.json");
    const raw = fs.readFileSync(repoFile, "utf8");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(raw).not.toMatch(/"apiKey"/);
    const registry = new ProviderRegistry({ file: repoFile, env: {}, readOnly: true });
    expect(registry.list().map((p) => p.id)).toContain("openrouter");
    expect(registry.profiles().map((p) => p.id)).toContain("professora-sonnet");
    expect(registry.defaults()?.profileId).toBe("professora-sonnet");
  });

  it("resolve a chave do ambiente, mascara na visão pública e nunca a serializa", () => {
    const file = tmpPath();
    const registry = new ProviderRegistry({ file, env: { OPENROUTER_API_KEY: "sk-or-v1-abcdefghijklmnop-a1b2" } });
    expect(registry.apiKey("openrouter")).toBe("sk-or-v1-abcdefghijklmnop-a1b2");
    expect(registry.hasApiKey("openrouter")).toBe(true);
    expect(registry.hasApiKey("anthropic")).toBe(false);

    const pub = registry.publicList().find((p) => p.id === "openrouter");
    expect(pub).toMatchObject({ hasApiKey: true, apiKeyEnv: "OPENROUTER_API_KEY", paid: true, local: false });
    expect(pub?.apiKeyMasked).toBe("sk-or-…a1b2");
    expect(JSON.stringify(registry.publicList())).not.toContain("abcdefghijklmnop");

    registry.save();
    const written = fs.readFileSync(file, "utf8");
    expect(written).not.toContain("abcdefghijklmnop");
    expect(written).not.toMatch(/"apiKey"/);
    expect(JSON.parse(written).providers[0].apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });

  it("maskKey só revela os 4 últimos caracteres", () => {
    expect(maskKey("sk-or-v1-0123456789abcdef")).toBe("sk-or-…cdef");
    expect(maskKey("curta12")).toBe("…ta12");
    expect(maskKey("  ")).toBe("");
    expect(maskKey("")).toBe("");
  });

  it("upsert/addPreset/remove gravam o arquivo sem chaves", () => {
    const file = tmpPath();
    const registry = new ProviderRegistry({ file, env: {} });
    registry.addPreset("lmstudio", "lmstudio-2");
    expect(registry.has("lmstudio-2")).toBe(true);
    expect(() => registry.addPreset("lmstudio", "lmstudio-2")).toThrowError(ProviderError);
    expect(() => registry.addPreset("inexistente")).toThrowError(ProviderError);

    registry.upsert("lmstudio-2", { baseUrl: "http://192.168.1.50:1234/v1", apiKey: "sk-vazado" } as never);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { providers: Record<string, unknown>[] };
    const entry = saved.providers.find((p) => p.id === "lmstudio-2") as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://192.168.1.50:1234/v1");
    expect(entry.apiKey).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).not.toContain("sk-vazado");

    expect(registry.remove("lmstudio-2")).toBe(true);
    expect(registry.remove("lmstudio-2")).toBe(false);
  });

  it("providers.json inválido não derruba o servidor (cai nos presets)", () => {
    const file = tmpPath();
    fs.writeFileSync(file, "{ isto não é json", "utf8");
    const registry = new ProviderRegistry({ file, env: {}, readOnly: true });
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("missingKeyReason explica a variável faltando (e ignora provedores locais)", () => {
    const registry = new ProviderRegistry({ env: {} });
    expect(registry.missingKeyReason("openrouter")).toBe("Provedor openrouter sem OPENROUTER_API_KEY no .env");
    expect(registry.missingKeyReason("ollama")).toBeNull();
    expect(registry.missingKeyReason("fantasma")).toMatch(/não existe/);
  });

  it("test() e models() cacheiam; refresh força nova chamada", async () => {
    let clock = 0;
    const { fetchImpl, calls } = mockFetch([() => json(LMSTUDIO_MODELS)]);
    const registry = new ProviderRegistry({ env: {}, fetchImpl, now: () => (clock += 10) });
    const result = await registry.test("lmstudio");
    expect(result.ok).toBe(true);
    expect(registry.publicList().find((p) => p.id === "lmstudio")?.lastTest).toMatchObject({ ok: true, models: 2 });

    await registry.models("lmstudio");
    await registry.models("lmstudio");
    expect(calls.filter((c) => c.url.endsWith("/models")).length).toBe(2); // test + 1º models
    await registry.models("lmstudio", true);
    expect(calls.filter((c) => c.url.endsWith("/models")).length).toBe(3);
  });

  it("test() de provedor quebrado registra o erro sem corpo bruto", async () => {
    const { fetchImpl } = mockFetch([() => new Response("<html>gateway down</html>", { status: 502 })]);
    const registry = new ProviderRegistry({ env: {}, fetchImpl });
    const result = await registry.test("lmstudio");
    expect(result.ok).toBe(false);
    const pub = registry.publicList().find((p) => p.id === "lmstudio");
    expect(pub?.lastTest?.ok).toBe(false);
    expect(pub?.lastTest?.error).toContain("gateway down");
  });

  it("provedor anthropic usa o adaptador da Messages API (fase F)", () => {
    const registry = new ProviderRegistry({ env: { ANTHROPIC_API_KEY: "sk-ant-1234" }, readOnly: true });
    const anthropic = registry.provider("anthropic");
    expect(anthropic.kind).toBe("anthropic");
    expect(registry.hasApiKey("anthropic")).toBe(true);
    expect(() => registry.provider("nao-existe")).toThrowError(/não está configurado/);
  });

  it("inject() registra um provedor em memória (FakeProvider)", async () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    const fake = createFakeProvider({ id: "fake" });
    registry.inject(fake, { name: "Fake" });
    expect(registry.provider("fake")).toBe(fake);
    expect(registry.publicList().find((p) => p.id === "fake")).toMatchObject({ hasApiKey: false, local: true });
    expect(await registry.models("fake")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* FakeProvider                                                        */
/* ------------------------------------------------------------------ */

describe("FakeProvider", () => {
  it("joga um lance do livro lido da lista de lances legais do prompt", async () => {
    const fake = createFakeProvider();
    const res = await fake.chat({
      model: "fake-1",
      messages: [{ role: "user", content: "Lances legais (é a sua vez; 20): a3 b3 e4 d4 Nf3 (capturas: nenhuma)" }],
    });
    expect(res.toolCalls[0]).toMatchObject({ name: "make_move" });
    expect(res.toolCalls[0].args.move).toBe("e4");
    expect(fake.calls).toHaveLength(1);
  });

  it("script tem precedência e o último passo se repete", async () => {
    const fake = createFakeProvider({
      script: [
        { toolCalls: [{ name: "comment", args: { text: "olá" } }] },
        { text: "só texto", finishReason: "stop" },
      ],
    });
    const req: ChatRequest = { model: "fake-1", messages: [{ role: "user", content: "vez" }] };
    expect((await fake.chat(req)).toolCalls[0].name).toBe("comment");
    expect((await fake.chat(req)).text).toBe("só texto");
    expect((await fake.chat(req)).text).toBe("só texto");
  });

  it("pode simular erro de provedor", async () => {
    const fake = createFakeProvider({
      script: [{ error: new ProviderError("chave inválida", { providerId: "fake", status: 401 }) }],
    });
    await expect(fake.chat({ model: "fake-1", messages: [] })).rejects.toThrowError(/chave inválida/);
  });
});

/* ------------------------------------------------------------------ */
/* redact()                                                           */
/* ------------------------------------------------------------------ */

describe("redact", () => {
  it("apaga chaves e Authorization dos logs", () => {
    expect(redact("usando sk-or-v1-0123456789abcdef no header")).toBe("usando sk-… no header");
    expect(redact("Authorization: Bearer sk-ant-api03-abcdefghij")).toContain("Bearer …");
    expect(redact('{"x-api-key":"sk-ant-0123456789"}')).not.toContain("0123456789");
    expect(redact("nada de segredo aqui")).toBe("nada de segredo aqui");
    expect(redact("a tarefa task-force-1 continua")).toBe("a tarefa task-force-1 continua");
  });
});
