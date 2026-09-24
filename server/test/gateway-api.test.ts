/**
 * Rotas /api/providers do gateway: ProvidersResponse (envKeys, canAdmin), criação e
 * limpeza via PUT, validações, ADMIN_ALLOW_FROM, teste de conexão com `hint` e
 * providers.json que virou pasta (500 com mensagem clara).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { GameStore } from "../src/game/store.js";
import { createApiRouter, type ApiDeps } from "../src/http/api.js";
import { ProviderRegistry, type ProviderRegistryOptions } from "../src/bots/providers/registry.js";

interface Harness {
  store: GameStore;
  registry: ProviderRegistry;
  base: string;
  server: Server;
}

let harness: Harness | null = null;

async function start(extra: Partial<ApiDeps> = {}, regOpts: ProviderRegistryOptions = {}): Promise<Harness> {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  const registry = new ProviderRegistry({ env: { OPENROUTER_API_KEY: "sk-or-v1-segredo-a1b2", MCP_TOKEN: "m" }, readOnly: true, ...regOpts });
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(
    "/api",
    createApiRouter({
      store,
      persistence: { listGames: () => [], readGamePgn: () => null },
      serverInfo: () => ({ version: "test", mcpUrl: "http://localhost:3939/mcp", mcpSessions: [] }),
      defaultHumanName: "Felipe",
      registry,
      ...extra,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  harness = { store, registry, base: `http://127.0.0.1:${port}`, server };
  return harness;
}

afterEach(async () => {
  if (!harness) return;
  const { server, store } = harness;
  harness = null;
  store.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(
  base: string,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

const REMOTE = { "x-forwarded-for": "203.0.113.7" };
const BRIDGE = { "x-forwarded-for": "172.18.0.1" };

describe("GET /api/providers — ProvidersResponse", () => {
  it("traz envKeys (só nomes), canAdmin e adminTokenAccepted", async () => {
    const { base } = await start({ adminToken: "segredo" });
    const local = await call(base, "GET", "/api/providers");
    expect(local.status).toBe(200);
    expect(local.json.envKeys).toEqual(["OPENROUTER_API_KEY"]);
    expect(local.json.canAdmin).toBe(true);
    expect(local.json.adminTokenAccepted).toBe(true);
    expect(JSON.stringify(local.json)).not.toContain("segredo");

    const remote = await call(base, "GET", "/api/providers", undefined, REMOTE);
    expect(remote.json.canAdmin).toBe(false);
    const comToken = await call(base, "GET", "/api/providers", undefined, { ...REMOTE, authorization: "Bearer segredo" });
    expect(comToken.json.canAdmin).toBe(true);
  });
});

describe("administração: ADMIN_ALLOW_FROM e 403 explicativo", () => {
  it("a bridge do Docker administra sem token; IP de fora recebe admin_forbidden", async () => {
    const { base } = await start({ adminAllowFrom: ["172.16.0.0/12"] });
    const ok = await call(base, "POST", "/api/providers/preset", { preset: "jan" }, BRIDGE);
    expect(ok.status).toBe(200);
    const denied = await call(base, "POST", "/api/providers/preset", { preset: "jan" }, REMOTE);
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: "admin_forbidden", adminTokenAccepted: false });
    expect(denied.json.error).toContain("ADMIN_ALLOW_FROM");
    expect(denied.json.error).toContain("ADMIN_TOKEN");
  });
});

describe("PUT /api/providers/:id — criar, atualizar, limpar", () => {
  it("cria um provedor novo e depois limpa apiKeyEnv/timeoutMs", async () => {
    const { base } = await start();
    const created = await call(base, "PUT", "/api/providers/meu-servidor", {
      name: "Meu servidor",
      kind: "openai",
      baseUrl: "http://192.168.0.20:8000/v1",
      apiKeyEnv: "MEU_SERVIDOR_API_KEY",
      timeoutMs: 120000,
      toolMode: "auto",
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      id: "meu-servidor",
      name: "Meu servidor",
      kind: "openai",
      baseUrl: "http://192.168.0.20:8000/v1",
      apiKeyEnv: "MEU_SERVIDOR_API_KEY",
      hasApiKey: false,
      local: true,
      timeoutMs: 120000,
      toolMode: "auto",
    });

    const cleared = await call(base, "PUT", "/api/providers/meu-servidor", { apiKeyEnv: null, timeoutMs: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.json.apiKeyEnv).toBeUndefined();
    expect(cleared.json.timeoutMs).toBeUndefined();
    expect(cleared.json.baseUrl).toBe("http://192.168.0.20:8000/v1");
  });

  it("valida id, URL, timeout e recusa chaves e extraHeaders", async () => {
    const { base } = await start();
    const bad = async (id: string, body: unknown): Promise<string> => {
      const res = await call(base, "PUT", `/api/providers/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return res.json.error as string;
    };
    expect(await bad("Nome_Com_Maiuscula", { baseUrl: "http://a/v1" })).toMatch(/Id inválido/);
    expect(await bad("novo", {})).toMatch(/exige `baseUrl`/);
    expect(await bad("novo", { baseUrl: "localhost:11434/v1" })).toMatch(/baseUrl/);
    expect(await bad("novo", { baseUrl: "http://a/v1", timeoutMs: 10 })).toMatch(/timeoutMs/);
    expect(await bad("novo", { baseUrl: "http://a/v1", kind: "gemini" })).toMatch(/kind/);
    expect(await bad("novo", { baseUrl: "http://a/v1", apiKeyEnv: "sk-123" })).toMatch(/apiKeyEnv/);
    expect(await bad("openrouter", { apiKey: "sk-vazado" })).toMatch(/Chaves de API não são aceitas/);
    expect(await bad("openrouter", { extraHeaders: { Authorization: "Bearer sk-vazado" } })).toMatch(/extraHeaders/);
  });

  it("POST /preset sem id ganha sufixo e informa o preset", async () => {
    const { base } = await start();
    const a = await call(base, "POST", "/api/providers/preset", { preset: "custom" });
    const b = await call(base, "POST", "/api/providers/preset", { preset: "custom" });
    expect([a.json.id, b.json.id]).toEqual(["custom", "custom-2"]);
    expect(b.json.preset).toBe("custom");
    const invalid = await call(base, "POST", "/api/providers/preset", { preset: "custom", id: "Com Espaço" });
    expect(invalid.status).toBe(400);
  });
});

describe("POST /api/providers/:id/test e GET /:id/models — erros com dica", () => {
  it("localhost no Docker: 502 com hint de host.docker.internal", async () => {
    const refused = async (): Promise<Response> => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    };
    const { base } = await start({ inDocker: true }, { fetchImpl: refused });
    const test = await call(base, "POST", "/api/providers/ollama/test", {});
    expect(test.status).toBe(502);
    expect(test.json.ok).toBe(false);
    expect(test.json.hint).toContain("host.docker.internal:11434");

    const models = await call(base, "GET", "/api/providers/ollama/models");
    expect(models.status).toBe(502);
    expect(models.json.hint).toContain("host.docker.internal");

    const list = await call(base, "GET", "/api/providers");
    const ollama = (list.json.providers as { id: string; lastTest?: { ok: boolean } }[]).find((p) => p.id === "ollama");
    expect(ollama?.lastTest?.ok).toBe(false);
  });
});

describe("providers.json que virou pasta", () => {
  it("escrita responde 500 com mensagem clara, sem EISDIR cru", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xadrez-gw-api-"));
    const file = path.join(dir, "providers.json");
    fs.mkdirSync(file);
    const { base } = await start({}, { file, readOnly: false });
    const res = await call(base, "POST", "/api/providers/preset", { preset: "jan" });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/é uma pasta/);
    const put = await call(base, "PUT", "/api/providers/x", { baseUrl: "http://a/v1" });
    expect(put.status).toBe(500);
  });
});
