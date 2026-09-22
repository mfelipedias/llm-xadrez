/**
 * Infra compartilhada dos testes de bot (fases C e D): API REST real numa porta efêmera,
 * `GameStore` limpo, `ProviderRegistry` em memória e `BotManager` com timeouts curtos.
 * Não é um arquivo de teste (o vitest só coleta `*.test.ts`).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { BotProfile, GameState } from "../../shared/types.js";
import { GameStore } from "../src/game/store.js";
import { createApiRouter } from "../src/http/api.js";
import { BotManager } from "../src/bots/manager.js";
import { ProviderRegistry } from "../src/bots/providers/registry.js";
import { createFakeProvider, legalMovesFromPrompt, type FakeProviderOptions } from "../src/bots/providers/fake.js";
import type { ChatMessage, ChatProvider, ProviderConfig } from "../src/bots/providers/types.js";

export interface Harness {
  store: GameStore;
  registry: ProviderRegistry;
  bots: BotManager;
  base: string;
  server: Server;
  close(): Promise<void>;
}

export interface StartOptions {
  providers?: { provider: ChatProvider; cfg?: Partial<ProviderConfig> }[];
  profiles?: BotProfile[];
}

export async function startHarness(opts: StartOptions = {}): Promise<Harness> {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  const registry = new ProviderRegistry({ env: {}, readOnly: true });
  for (const entry of opts.providers ?? []) {
    registry.inject(entry.provider, { local: true, toolMode: "native", ...(entry.cfg ?? {}) });
  }
  for (const profile of opts.profiles ?? []) registry.upsertProfile(profile);

  const bots = new BotManager({
    store,
    registry,
    player: { waitTimeoutMs: 100, turnTimeoutMs: 2000, backoffBaseMs: 5, maxBackoffMs: 10, maxRetriesPerCall: 1 },
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createApiRouter({
      store,
      persistence: { listGames: () => [], readGamePgn: () => null },
      serverInfo: () => ({ version: "test", mcpUrl: "http://localhost:3939/mcp", mcpSessions: [], bots: store.botSeats() }),
      defaultHumanName: "Felipe",
      registry,
      bots,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    store,
    registry,
    bots,
    server,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      bots.stopAll();
      store.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function post(base: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

export async function state(base: string): Promise<GameState> {
  const res = await fetch(`${base}/api/state`);
  return (await res.json()) as GameState;
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function botSeat(providerId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "bot", providerId, model: "fake-1", ...extra };
}

/** Provedor falso que joga sempre o 1º lance legal anunciado no prompt (tools nativas). */
export function firstLegalProvider(id: string, opts: Partial<FakeProviderOptions> = {}) {
  return createFakeProvider({
    id,
    onChat: (req) => {
      const legal = legalMovesFromPrompt(req);
      if (!legal.length) return { text: "Não vejo a posição." };
      return {
        toolCalls: [{ name: "make_move", args: { move: legal[0], comment: `Jogo ${legal[0]}.` } }],
        finishReason: "tool_calls",
      };
    },
    ...opts,
  });
}

export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}
