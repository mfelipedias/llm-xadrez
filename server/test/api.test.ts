/**
 * API REST: novo contrato `seats` em POST /api/game (docs/09, fase A) e as rotas
 * /api/providers* (fase B). Sobe um express real em porta efêmera e usa `fetch`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GameState, ProviderPublic } from "../../shared/types.js";
import { GameStore } from "../src/game/store.js";
import { createApiRouter, type ApiDeps } from "../src/http/api.js";
import { ProviderRegistry } from "../src/bots/providers/registry.js";
import { createFakeProvider } from "../src/bots/providers/fake.js";

interface Harness {
  store: GameStore;
  registry: ProviderRegistry;
  base: string;
  server: Server;
}

let harness: Harness | null = null;

async function start(extra: Partial<ApiDeps> = {}): Promise<Harness> {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  const registry = new ProviderRegistry({
    env: { OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef-a1b2" },
    readOnly: true,
  });
  registry.inject(createFakeProvider({ id: "fake" }), { name: "Fake" });
  registry.upsertProfile({
    id: "fake-teacher",
    name: "Professora (fake)",
    providerId: "fake",
    model: "fake-1",
    role: "teacher",
    level: "beginner",
  });

  const app = express();
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

async function post(base: string, path: string, body: unknown, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function get(base: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: (await res.json()) as unknown };
}

/* ------------------------------------------------------------------ */
/* POST /api/game com `seats`                                          */
/* ------------------------------------------------------------------ */

describe("POST /api/game — seats", () => {
  beforeEach(async () => {
    await start();
  });

  it("humano de brancas vs bot de pretas (perfil do providers.json)", async () => {
    const { base } = harness as Harness;
    const { status, json } = await post(base, "/api/game", {
      seats: { white: { kind: "human", name: "Felipe" }, black: { kind: "bot", profileId: "fake-teacher" } },
    });
    expect(status).toBe(200);
    const state = json as GameState;
    expect(state.seats.white).toMatchObject({ kind: "human", name: "Felipe" });
    expect(state.seats.black).toMatchObject({ kind: "bot", name: "Professora (fake)" });
    expect(state.seats.black.bot).toMatchObject({ providerId: "fake", model: "fake-1", profileId: "fake-teacher" });
    expect(state.status).toBe("active");
  });

  it("aceita providerId + model sem perfil", async () => {
    const { base } = harness as Harness;
    const { json } = await post(base, "/api/game", {
      seats: { white: { kind: "bot", providerId: "fake", model: "fake-1", name: "Bot A" }, black: { kind: "bot", providerId: "fake", model: "fake-1" } },
    });
    const state = json as GameState;
    expect(state.seats.white.name).toBe("Bot A");
    expect(state.seats.black.name).toBe("fake/fake-1");
  });

  it("kind mcp deixa o assento vazio esperando join_game; startFen respeitado", async () => {
    const { base, store } = harness as Harness;
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    const { json } = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "mcp" } },
      startFen: fen,
    });
    const state = json as GameState;
    expect(state.seats.black.kind).toBe("empty");
    expect(state.status).toBe("waiting");
    expect(state.fen).toBe(fen);
    expect(store.getState().startFen).toBe(fen);
  });

  it("mantém uma sessão MCP viva que já estava na cor", async () => {
    const { base, store } = harness as Harness;
    store.sessionOpened("mcp-1");
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "mcp", name: "Claude", sessionId: "mcp-1" } } });
    const { json } = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "mcp" } },
    });
    expect((json as GameState).seats.black).toMatchObject({ kind: "mcp", name: "Claude", sessionId: "mcp-1" });
  });

  it("bot sem perfil/modelo ou com provedor inexistente => 400 explicativo", async () => {
    const { base } = harness as Harness;
    const semModelo = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "bot" } },
    });
    expect(semModelo.status).toBe(400);
    expect(semModelo.json.error).toMatch(/profileId/);

    const perfilErrado = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "bot", profileId: "nao-existe" } },
    });
    expect(perfilErrado.status).toBe(400);

    const semProvedor = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "bot", providerId: "fantasma", model: "x" } },
    });
    expect(semProvedor.status).toBe(400);
    expect(semProvedor.json.error).toMatch(/não está configurado/);
  });

  it("provedor pago sem chave no .env => 400 citando a variável", async () => {
    const { base, registry } = harness as Harness;
    // O registry do teste só tem OPENROUTER_API_KEY; o preset anthropic fica sem chave.
    expect(registry.hasApiKey("anthropic")).toBe(false);
    const { status, json } = await post(base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "bot", providerId: "anthropic", model: "claude-opus-5" } },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Provedor anthropic sem ANTHROPIC_API_KEY no .env");
  });

  it("o contrato antigo (humanSeats) continua valendo", async () => {
    const { base } = harness as Harness;
    const { json } = await post(base, "/api/game", { humanSeats: "both", humanName: "Felipe" });
    const state = json as GameState;
    expect(state.seats.white.kind).toBe("human");
    expect(state.seats.black.kind).toBe("human");
  });
});

/* ------------------------------------------------------------------ */
/* /api/providers*                                                     */
/* ------------------------------------------------------------------ */

describe("/api/providers", () => {
  it("GET lista provedores mascarados, perfis e presets", async () => {
    const { base } = await start();
    const { status, json } = await get(base, "/api/providers");
    expect(status).toBe(200);
    const providers = json.providers as ProviderPublic[];
    const openrouter = providers.find((p) => p.id === "openrouter") as ProviderPublic;
    expect(openrouter.hasApiKey).toBe(true);
    expect(openrouter.apiKeyMasked).toBe("sk-or-…a1b2");
    expect(JSON.stringify(json)).not.toContain("0123456789abcdef");
    expect((json.profiles as { id: string }[]).map((p) => p.id)).toContain("fake-teacher");
    expect(json.presets).toContain("ollama");
  });

  it("POST /:id/test devolve latência e nº de modelos", async () => {
    const { base } = await start();
    const { status, json } = await post(base, "/api/providers/fake/test", {});
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, models: 1 });
  });

  it("GET /:id/models lista modelos; provedor inexistente => 404", async () => {
    const { base } = await start();
    const ok = await get(base, "/api/providers/fake/models");
    expect(ok.status).toBe(200);
    expect(ok.json[0].id).toBe("fake-1");
    const missing = await get(base, "/api/providers/fantasma/models");
    expect(missing.status).toBe(404);
  });

  it("PUT recusa chave no body e grava o resto", async () => {
    const { base } = await start();
    const comChave = await post(base, "/api/providers/lmstudio", { apiKey: "sk-vazado" }, { method: "PUT" });
    expect(comChave.status).toBe(400);
    expect(comChave.json.error).toMatch(/Chaves de API não são aceitas/);

    const ok = await post(base, "/api/providers/lmstudio", { baseUrl: "http://localhost:4321/v1" }, { method: "PUT" });
    expect(ok.status).toBe(200);
    expect(ok.json.baseUrl).toBe("http://localhost:4321/v1");
    expect(ok.json.apiKeyMasked).toBeUndefined();
  });

  it("POST /preset adiciona e DELETE remove", async () => {
    const { base } = await start();
    const added = await post(base, "/api/providers/preset", { preset: "jan" });
    expect(added.status).toBe(200);
    expect(added.json.id).toBe("jan");
    const duplicado = await post(base, "/api/providers/preset", { preset: "jan" });
    expect(duplicado.status).toBe(409);
    const invalido = await post(base, "/api/providers/preset", { preset: "inexistente" });
    expect(invalido.status).toBe(400);

    const removed = await fetch(`${base}/api/providers/jan`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const again = await fetch(`${base}/api/providers/jan`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("DELETE recusa provedor em uso por um bot da partida atual", async () => {
    const { base, store } = await start();
    store.newGame({
      seats: {
        white: { kind: "human" },
        black: {
          kind: "bot",
          name: "Fake",
          sessionId: "bot:black:1",
          bot: { providerId: "fake", model: "fake-1", toolMode: "native", status: "waiting", usage: { calls: 0, inputTokens: 0, outputTokens: 0, illegalMoves: 0 } },
        },
      },
    });
    const res = await fetch(`${base}/api/providers/fake`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("com MCP_TOKEN, escrita exige o Bearer", async () => {
    const { base } = await start({ adminToken: "segredo" });
    const semToken = await post(base, "/api/providers/preset", { preset: "jan" });
    expect(semToken.status).toBe(403);
    const comToken = await post(base, "/api/providers/preset", { preset: "jan" }, { headers: { authorization: "Bearer segredo" } });
    expect(comToken.status).toBe(200);
    // Leitura continua livre.
    expect((await get(base, "/api/providers")).status).toBe(200);
  });
});
