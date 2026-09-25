/**
 * Camada HTTP do MCP: token (header e ?token=), initialize com Mcp-Session-Id velho,
 * varredura de sessões ociosas, validação do header Host (DNS rebinding) e /.well-known 404.
 * Sobe um express real em porta efêmera e fala HTTP cru (node:http, para controlar o Host).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameStore } from "../src/game/store.js";
import { createMcpRouter, safeTokenEqual, type McpRouterHandle, type McpTransportOptions } from "../src/mcp/transport.js";
import { buildHostPolicy, hostValidationMiddleware, normalizeHostEntry, wellKnownNotFound } from "../src/mcp/guards.js";

interface Harness {
  store: GameStore;
  mcp: McpRouterHandle;
  port: number;
  server: http.Server;
}

let harness: Harness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (!harness) return;
  const h = harness;
  harness = null;
  await h.mcp.closeAll();
  h.server.closeAllConnections();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
});

async function start(opts: Partial<McpTransportOptions> = {}, hosts: { baseUrl?: string; extra?: string[] } = {}): Promise<Harness> {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  const app = express();
  app.use(hostValidationMiddleware(buildHostPolicy({ baseUrl: hosts.baseUrl ?? "http://localhost:3939", bindHost: "0.0.0.0", extra: hosts.extra })));
  app.use(express.json());
  const mcp = createMcpRouter(store, { version: "test", progressIntervalMs: 0, ...opts });
  app.use("/mcp", mcp.router);
  app.use("/.well-known", wellKnownNotFound);
  // Fallback da SPA, como no index.ts.
  app.use((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send("<!doctype html><title>spa</title>");
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  harness = { store, mcp, port, server };
  return harness;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `localhost:${port}`,
          accept: "application/json, text/event-stream",
          ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "0.0.1" } },
};

async function initialize(port: number, headers: Record<string, string> = {}, path = "/mcp"): Promise<RawResponse & { sessionId?: string }> {
  const res = await request(port, "POST", path, headers, initializeBody);
  const sid = res.headers["mcp-session-id"];
  return { ...res, sessionId: Array.isArray(sid) ? sid[0] : sid };
}

describe("MCP HTTP — token", () => {
  it("safeTokenEqual compara em tempo constante e trata tamanhos diferentes", () => {
    expect(safeTokenEqual("abc", "abc")).toBe(true);
    expect(safeTokenEqual("abc", "abcd")).toBe(false);
    expect(safeTokenEqual("", "abc")).toBe(false);
    expect(safeTokenEqual("abd", "abc")).toBe(false);
  });

  it("aceita Bearer ou ?token=; recusa ausente/errado com 401 + WWW-Authenticate", async () => {
    const { port } = await start({ token: "segredo-123" });
    const none = await initialize(port);
    expect(none.status).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    expect(none.body).not.toContain("segredo-123");

    expect((await initialize(port, { authorization: "Bearer errado" })).status).toBe(401);
    expect((await initialize(port, {}, "/mcp?token=errado")).status).toBe(401);
    expect((await initialize(port, {}, "/mcp?token=segredo-1234")).status).toBe(401);

    const header = await initialize(port, { authorization: "Bearer segredo-123" });
    expect(header.status).toBe(200);
    expect(header.sessionId).toBeTruthy();

    const query = await initialize(port, {}, "/mcp?token=segredo-123");
    expect(query.status).toBe(200);
    expect(query.sessionId).toBeTruthy();
    // Requisições seguintes da sessão também podem usar ?token=.
    const list = await request(port, "POST", "/mcp?token=segredo-123", { "mcp-session-id": query.sessionId!, "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(list.status).toBe(202);
  });
});

describe("MCP HTTP — tools/list", () => {
  it("esquemas sem $schema draft-07 e válidos para um validador 2020-12 (Claude Desktop)", async () => {
    const { port } = await start();
    const { sessionId } = await initialize(port);
    const headers = { "mcp-session-id": sessionId ?? "", "mcp-protocol-version": "2025-06-18" };
    await request(port, "POST", "/mcp", headers, { jsonrpc: "2.0", method: "notifications/initialized" });
    const res = await request(port, "POST", "/mcp", headers, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const line = res.body.split("\n").find((l) => l.startsWith("data: "));
    const tools = (JSON.parse(line?.slice(6) ?? "{}") as { result: { tools: Record<string, Record<string, unknown>>[] } }).result.tools;
    expect(tools.length).toBeGreaterThan(5);

    const ajv = new Ajv2020({ strict: false });
    for (const tool of tools) {
      for (const key of ["inputSchema", "outputSchema"]) {
        const schema = tool[key];
        if (!schema) continue;
        expect(schema, `${String(tool.name)}.${key}`).not.toHaveProperty("$schema");
        expect(() => ajv.compile(schema), `${String(tool.name)}.${key}`).not.toThrow();
      }
    }
  });
});

describe("MCP HTTP — sessões", () => {
  it("initialize com Mcp-Session-Id velho abre sessão nova; outras requisições com id velho => 404", async () => {
    const { port, mcp, store } = await start();
    const r = await initialize(port, { "mcp-session-id": "sessao-que-nao-existe" });
    expect(r.status).toBe(200);
    expect(r.sessionId).toBeTruthy();
    expect(r.sessionId).not.toBe("sessao-que-nao-existe");
    expect(mcp.sessionIds()).toEqual([r.sessionId]);
    expect(store.isSessionOpen(r.sessionId)).toBe(true);

    const stale = await request(port, "POST", "/mcp", { "mcp-session-id": "sessao-que-nao-existe" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(stale.status).toBe(404);
  });

  it("varredura fecha sessões ociosas (e o store as descarta), mas nunca com wait_for_turn pendente", async () => {
    let t = 1_000_000;
    const { port, mcp, store } = await start({ now: () => t, sessionIdleMs: 30 * 60_000 });
    const a = (await initialize(port)).sessionId!;
    const b = (await initialize(port)).sessionId!;
    // `b` está sentado e bloqueado em wait_for_turn.
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "mcp", name: "B", sessionId: b } } });
    const ac = new AbortController();
    const waiting = store.waitForTurn("black", 60_000, { sessionId: b, signal: ac.signal });

    t += 29 * 60_000;
    expect(await mcp.sweepIdle()).toBe(0);
    t += 2 * 60_000;
    expect(await mcp.sweepIdle()).toBe(1);
    expect(mcp.sessionIds()).toEqual([b]);
    expect(store.isSessionOpen(a)).toBe(false);
    expect(store.isSessionOpen(b)).toBe(true);
    expect((await request(port, "POST", "/mcp", { "mcp-session-id": a }, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(404);

    ac.abort();
    await waiting;
    expect(await mcp.sweepIdle()).toBe(1);
    expect(mcp.sessionIds()).toEqual([]);
    expect(store.sessionCount).toBe(0);
  });

  it("requisição renova a sessão; a varredura roda sozinha no intervalo (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let t = 1_000_000;
    const { port, mcp, store } = await start({ now: () => t, sessionIdleMs: 60_000, sweepIntervalMs: 1000 });
    const a = (await initialize(port)).sessionId!;
    t += 50_000;
    const touched = await request(port, "POST", "/mcp", { "mcp-session-id": a, "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(touched.status).toBe(202);
    t += 50_000;
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(mcp.sessionIds()).toEqual([a]));
    t += 20_000;
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(mcp.sessionIds()).toEqual([]));
    expect(store.isSessionOpen(a)).toBe(false);
  });
});

describe("Host (DNS rebinding) e /.well-known", () => {
  it("política: loopback, host da PUBLIC_URL, porta ignorada, curinga com ponto, IPv6, *", () => {
    const p = buildHostPolicy({ baseUrl: "https://xadrez.exemplo.com", bindHost: "0.0.0.0", extra: [".trycloudflare.com", "::1", "192.168.0.10:3939"] });
    expect(p.allows("localhost:3939")).toBe(true);
    expect(p.allows("127.0.0.1")).toBe(true);
    expect(p.allows("[::1]:3939")).toBe(true);
    expect(p.allows("xadrez.exemplo.com")).toBe(true);
    expect(p.allows("XADREZ.exemplo.com:443")).toBe(true);
    expect(p.allows("abc-def.trycloudflare.com")).toBe(true);
    expect(p.allows("trycloudflare.com")).toBe(true);
    expect(p.allows("eviltrycloudflare.com")).toBe(false);
    expect(p.allows("192.168.0.10:8080")).toBe(true);
    expect(p.allows("evil.example")).toBe(false);
    expect(p.allows(undefined)).toBe(false);
    expect(p.allows("0.0.0.0:3939")).toBe(false);
    expect(buildHostPolicy({ extra: ["*"] }).allows("qualquer.coisa")).toBe(true);
    expect(buildHostPolicy({ bindHost: "10.0.0.5" }).allows("10.0.0.5:3939")).toBe(true);
    expect(normalizeHostEntry("*.exemplo.com")).toBe(".exemplo.com");
    expect(normalizeHostEntry("https://Exemplo.com:8443/mcp")).toBe("exemplo.com");
  });

  it("Host desconhecido => 403 com instrução (PUBLIC_URL/ALLOWED_HOSTS) em /mcp e no resto do app", async () => {
    const { port } = await start({}, { extra: [".trycloudflare.com"] });
    const evil = await initialize(port, { host: "evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.body).toContain("PUBLIC_URL");
    expect(evil.body).toContain("ALLOWED_HOSTS");
    expect((await request(port, "GET", "/", { host: "evil.example:3939", accept: "text/html" })).status).toBe(403);
    const tunnel = await initialize(port, { host: "abc.trycloudflare.com" });
    expect(tunnel.status).toBe(200);
  });

  it("/.well-known/* => 404 JSON (não cai no fallback da SPA)", async () => {
    const { port } = await start();
    const r = await request(port, "GET", "/.well-known/oauth-protected-resource", { accept: "*/*" });
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toContain("application/json");
    const spa = await request(port, "GET", "/qualquer", { accept: "text/html" });
    expect(spa.status).toBe(200);
  });
});
