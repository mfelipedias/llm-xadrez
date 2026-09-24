/**
 * Registry do gateway: criação/limpeza de campos, envKeys, preset com sufixo, inferência
 * de `local` (sem chave + `Bearer local`), timeout curto do teste, diagnóstico de erros de
 * rede (com dicas do Docker) e providers.json que virou pasta.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, ProvidersFileError } from "../src/bots/providers/registry.js";
import { diagnoseProviderError, errorCode } from "../src/bots/providers/diagnose.js";
import { validateProviderUpsert } from "../src/bots/providers/validate.js";
import { MODELS_TIMEOUT_MS, ProviderError, type ProviderConfig } from "../src/bots/providers/types.js";
import type { FetchLike } from "../src/bots/providers/openai-compat.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xadrez-gw-"));
}

/** Erro como o `fetch` do Node lança: TypeError("fetch failed") com `cause.code`. */
function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

function failingFetch(err: unknown): FetchLike {
  return async () => {
    throw err;
  };
}

const MODELS_OK = { object: "list", data: [{ id: "qwen3-8b" }] };

describe("ProviderRegistry — criar, atualizar e limpar", () => {
  it("cria provedor novo e limpa campos opcionais com null ou \"\"", () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    const created = registry.upsert("meu-servidor", {
      name: "Meu servidor",
      baseUrl: "http://192.168.0.10:8000/v1",
      apiKeyEnv: "MEU_SERVIDOR_API_KEY",
      timeoutMs: 90_000,
    });
    expect(created).toMatchObject({ id: "meu-servidor", kind: "openai", timeoutMs: 90_000, apiKeyEnv: "MEU_SERVIDOR_API_KEY" });

    const cleared = registry.upsert("meu-servidor", { apiKeyEnv: null, timeoutMs: null, name: "" });
    expect(cleared.apiKeyEnv).toBeUndefined();
    expect(cleared.timeoutMs).toBeUndefined();
    expect(cleared.name).toBe("meu-servidor");
    expect(cleared.baseUrl).toBe("http://192.168.0.10:8000/v1");

    const pub = registry.toPublic(cleared);
    expect(pub.local).toBe(true); // IP da LAN
    expect(pub.timeoutMs).toBeUndefined();
    expect(registry.toPublic(created).timeoutMs).toBe(90_000);
  });

  it("toPublic expõe timeoutMs e preset; addPreset sem id ganha sufixo", () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    const first = registry.addPreset("custom");
    const second = registry.addPreset("custom");
    const third = registry.addPreset("custom");
    expect([first.id, second.id, third.id]).toEqual(["custom", "custom-2", "custom-3"]);
    expect(registry.toPublic(second).preset).toBe("custom");
    expect(() => registry.addPreset("custom", "custom-2")).toThrowError(/Já existe/);
    const openrouter = registry.publicList().find((p) => p.id === "openrouter");
    expect(openrouter).toMatchObject({ preset: "openrouter", timeoutMs: 60_000 });
  });

  it("envKeyNames lista só NOMES de variáveis com cara de chave, sem os segredos do servidor", () => {
    const registry = new ProviderRegistry({
      env: {
        OPENROUTER_API_KEY: "sk-or-1",
        MEU_SERVIDOR_KEY: "abc",
        GROQ_TOKEN: "t",
        VAZIA_API_KEY: "  ",
        MCP_TOKEN: "segredo",
        ADMIN_TOKEN: "segredo2",
        PATH: "/usr/bin",
      },
      readOnly: true,
    });
    const names = registry.envKeyNames();
    expect(names).toEqual(["GROQ_TOKEN", "MEU_SERVIDOR_KEY", "OPENROUTER_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain("sk-or-1");
  });
});

describe("ProviderRegistry — provedor local na LAN", () => {
  it("baseUrl na rede local dispensa chave e manda `Bearer local`", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify(MODELS_OK), { status: 200, headers: { "content-type": "application/json" } });
    };
    const registry = new ProviderRegistry({ env: {}, readOnly: true, fetchImpl });
    registry.upsert("pc-da-sala", { baseUrl: "http://192.168.1.50:11434/v1", apiKeyEnv: "PC_SALA_API_KEY" });
    expect(registry.missingKeyReason("pc-da-sala")).toBeNull();
    const result = await registry.test("pc-da-sala");
    expect(result.ok).toBe(true);
    expect(seen[0].Authorization).toBe("Bearer local");
  });

  it("host público com apiKeyEnv e sem a variável => missingKeyReason", () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    registry.upsert("remoto", { baseUrl: "https://llm.exemplo.com/v1", apiKeyEnv: "REMOTO_API_KEY" });
    expect(registry.missingKeyReason("remoto")).toContain("REMOTO_API_KEY");
  });

  it("o teste de conexão usa o timeout curto, não o do chat", async () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true });
    const seen: (number | undefined)[] = [];
    registry.inject(
      {
        id: "lento",
        kind: "openai",
        supportsTools: true,
        chat: async () => ({ text: "", toolCalls: [], finishReason: "stop" }),
        listModels: async (opts) => {
          seen.push(opts?.timeoutMs);
          return [];
        },
        test: async () => ({ ok: true, latencyMs: 0, models: 0 }),
      },
      { timeoutMs: 600_000 },
    );
    await registry.test("lento");
    expect(seen).toEqual([MODELS_TIMEOUT_MS]);
  });
});

describe("diagnóstico de erros de conexão", () => {
  const ollamaLocal: Pick<ProviderConfig, "id" | "kind" | "baseUrl"> = { id: "ollama", kind: "openai", baseUrl: "http://localhost:11434/v1" };

  it("errorCode percorre a cadeia de causas (ProviderError → TypeError → código)", () => {
    const wrapped = new ProviderError("Falha de rede", { providerId: "x", cause: fetchFailed("ECONNREFUSED") });
    expect(errorCode(wrapped)).toBe("ECONNREFUSED");
  });

  it("localhost dentro do Docker sugere host.docker.internal com a mesma porta", async () => {
    const registry = new ProviderRegistry({ env: {}, readOnly: true, fetchImpl: failingFetch(fetchFailed("ECONNREFUSED")) });
    const result = await registry.test("ollama", { inDocker: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain("http://host.docker.internal:11434/v1");
    expect(result.hint).toContain("localhost é o próprio container");
    expect(registry.publicList().find((p) => p.id === "ollama")?.lastTest).toMatchObject({ ok: false });
  });

  it("ECONNREFUSED em host.docker.internal/LAN pede para escutar em 0.0.0.0", () => {
    const d = diagnoseProviderError(fetchFailed("ECONNREFUSED"), { id: "x", kind: "openai", baseUrl: "http://host.docker.internal:11434/v1" }, { inDocker: true });
    expect(d.error).toContain("Conexão recusada");
    expect(d.hint).toContain("OLLAMA_HOST=0.0.0.0");
    const lan = diagnoseProviderError(fetchFailed("ECONNREFUSED"), { id: "x", kind: "openai", baseUrl: "http://192.168.0.9:1234/v1" });
    expect(lan.hint).toContain("Serve on Local Network");
  });

  it("ECONNREFUSED em localhost fora do Docker lembra de subir o servidor", () => {
    const d = diagnoseProviderError(fetchFailed("ECONNREFUSED"), ollamaLocal, { inDocker: false });
    expect(d.hint).toMatch(/está rodando/);
  });

  it("ENOTFOUND de host.docker.internal: dentro do Docker => extra_hosts; fora => localhost", () => {
    const cfg = { id: "x", kind: "openai" as const, baseUrl: "http://host.docker.internal:11434/v1" };
    expect(diagnoseProviderError(fetchFailed("ENOTFOUND"), cfg, { inDocker: true }).hint).toContain("host-gateway");
    expect(diagnoseProviderError(fetchFailed("ENOTFOUND"), cfg, { inDocker: false }).hint).toContain("fora dele, use localhost");
    expect(diagnoseProviderError(fetchFailed("EAI_AGAIN"), { id: "x", kind: "openai", baseUrl: "https://api.x.com/v1" }).error).toMatch(/DNS/);
  });

  it("timeout, reset e certificado viram mensagens claras", () => {
    const lan = { id: "x", kind: "openai" as const, baseUrl: "http://10.0.0.2:8000/v1" };
    const abort = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const t = diagnoseProviderError(abort, lan, { timeoutMs: 10_000 });
    expect(t.error).toContain("10 s");
    expect(t.hint).toMatch(/Firewall/);
    expect(diagnoseProviderError(fetchFailed("ETIMEDOUT"), lan).error).toMatch(/timeout/);
    expect(diagnoseProviderError(fetchFailed("ECONNRESET"), lan).hint).toMatch(/http:\/\/ vs https:\/\//);
    for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]) {
      const d = diagnoseProviderError(fetchFailed(code), { id: "x", kind: "openai", baseUrl: "https://gpu.lan/v1" });
      expect(d.error).toContain("Certificado");
      expect(d.hint).toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  it("HTTP 401/403 e 404 dão dicas de chave e de /v1", async () => {
    const unauthorized = new ProviderError("chave de API inválida ou ausente", { providerId: "x", status: 401 });
    expect(diagnoseProviderError(unauthorized, { id: "x", kind: "openai", baseUrl: "https://a.b/v1", apiKeyEnv: "X_API_KEY" }).hint).toContain("X_API_KEY");
    expect(diagnoseProviderError(unauthorized, { id: "x", kind: "openai", baseUrl: "https://a.b/v1" }).hint).toContain("apiKeyEnv");
    const forbidden = new ProviderError("proibido", { providerId: "x", status: 403 });
    expect(diagnoseProviderError(forbidden, { id: "x", kind: "openai", baseUrl: "https://a.b/v1" }).hint).toContain("apiKeyEnv");

    const fetchImpl: FetchLike = async () => new Response("not found", { status: 404 });
    const registry = new ProviderRegistry({ env: {}, readOnly: true, fetchImpl });
    const result = await registry.test("lmstudio");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
      expect(result.hint).toContain("/v1");
    }
  });
});

describe("validateProviderUpsert", () => {
  it("valida id, kind, baseUrl, timeoutMs, toolMode e booleanos", () => {
    expect(validateProviderUpsert("Maiusculo", { baseUrl: "http://a/v1" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("-x", { baseUrl: "http://a/v1" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("ok_1", { baseUrl: "http://a/v1" }, undefined).ok).toBe(true);
    expect(validateProviderUpsert("x", { kind: "gemini", baseUrl: "http://a/v1" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", {}, undefined).ok).toBe(false); // openai sem baseUrl
    expect(validateProviderUpsert("x", { kind: "anthropic" }, undefined).ok).toBe(true);
    expect(validateProviderUpsert("x", { baseUrl: "ftp://a/v1" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "localhost:11434" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://user:senha@a/v1" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://a/v1", timeoutMs: 999 }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://a/v1", timeoutMs: 600_001 }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://a/v1", timeoutMs: "abc" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://a/v1", toolMode: "magic" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: "http://a/v1", local: "sim" }, undefined).ok).toBe(false);
    const ok = validateProviderUpsert("x", { baseUrl: " http://a:1/v1/ ", timeoutMs: 1000, local: true, toolMode: "text" }, undefined);
    expect(ok).toMatchObject({ ok: true, created: true, patch: { baseUrl: "http://a:1/v1", timeoutMs: 1000, local: true, toolMode: "text" } });
  });

  it("apiKeyEnv precisa ser nome de variável com cara de chave (e nunca MCP_TOKEN/ADMIN_TOKEN)", () => {
    const base = { baseUrl: "http://a/v1" };
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "sk-abc123" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "HOME" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "MCP_TOKEN" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "ADMIN_TOKEN" }, undefined).ok).toBe(false);
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "MEU_SERVIDOR_API_KEY" }, undefined).ok).toBe(true);
    expect(validateProviderUpsert("x", { ...base, apiKeyEnv: "" }, undefined)).toMatchObject({ ok: true, patch: { apiKeyEnv: null } });
  });

  it("recusa chaves e extraHeaders; limpar baseUrl de um openai existente é erro", () => {
    const existing: ProviderConfig = { id: "x", name: "X", kind: "openai", baseUrl: "http://a/v1" };
    expect(validateProviderUpsert("x", { apiKey: "sk" }, existing).ok).toBe(false);
    expect(validateProviderUpsert("x", { token: "sk" }, existing).ok).toBe(false);
    expect(validateProviderUpsert("x", { extraHeaders: { Authorization: "Bearer sk" } }, existing).ok).toBe(false);
    expect(validateProviderUpsert("x", { baseUrl: null }, existing).ok).toBe(false);
    expect(validateProviderUpsert("x", { timeoutMs: null }, existing)).toMatchObject({ ok: true, created: false, patch: { timeoutMs: null } });
  });
});

describe("providers.json que virou pasta (bind mount do Docker)", () => {
  it("carrega os presets com aviso e recusa gravar com erro claro", () => {
    const dir = tmpDir();
    const asDir = path.join(dir, "providers.json");
    fs.mkdirSync(asDir);
    const registry = new ProviderRegistry({ file: asDir, env: {} });
    expect(registry.list().length).toBeGreaterThan(0);
    expect(() => registry.addPreset("jan")).toThrowError(ProvidersFileError);
    expect(() => registry.upsert("x", { baseUrl: "http://a/v1" })).toThrowError(/é uma pasta/);
    // A mudança que falhou ao gravar não fica só na memória.
    expect(registry.has("jan")).toBe(false);
    expect(registry.has("x")).toBe(false);
  });
});
