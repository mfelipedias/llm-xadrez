/**
 * Smoke test ponta a ponta: cliente MCP real (StreamableHTTPClientTransport) contra /mcp,
 * com `fetch` na REST simulando o humano. Ver docs/06 (Agente A, itens 6 e 7).
 *
 * Uso: `npm run smoke`. Por padrão SEMPRE spawna `tsx server/src/index.ts` numa porta livre
 * (SMOKE_PORT para fixar), com DATA_DIR temporário e um MCP_TOKEN aleatório, e mata no fim —
 * nunca cria partidas no servidor "de verdade" em :3939 (nem no container Docker).
 * Para rodar contra um servidor já no ar: `SMOKE_URL=http://localhost:3939 [SMOKE_TOKEN=...] npm run smoke`
 * (ATENÇÃO: isso arquiva/substitui a partida atual dele).
 * Termina com "OK" (exit 0) ou erro (exit 1).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import type { GameState, ServerInfo, TurnEvent } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const REQUEST_TIMEOUT_MS = 130_000;

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

class SmokeError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SmokeError(msg);
}

function textOf(r: ToolResult): string {
  const first = r.content[0];
  return first && first.type === "text" && first.text ? first.text : "";
}

function headline(r: ToolResult, lines = 2): string {
  return textOf(r).split("\n").slice(0, lines).join(" | ");
}

/* ------------------------------------------------------------------ */
/* Servidor: usa o que estiver no ar ou spawna um                      */
/* ------------------------------------------------------------------ */

async function isUp(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean };
    return json.ok === true;
  } catch {
    return false;
  }
}

interface SmokeServer {
  base: string;
  /** MCP_TOKEN do servidor ("" = sem token). */
  token: string;
  child: ChildProcess | null;
  dataDir: string | null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function ensureServer(): Promise<SmokeServer> {
  const external = process.env.SMOKE_URL?.replace(/\/+$/, "");
  if (external) {
    assert(await isUp(external), `SMOKE_URL=${external} não responde em /api/health`);
    console.log(`[smoke] usando servidor já no ar em ${external} (SMOKE_URL)`);
    return { base: external, token: process.env.SMOKE_TOKEN ?? "", child: null, dataDir: null };
  }
  const port = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : await freePort();
  const base = `http://localhost:${port}`;
  assert(!(await isUp(base)), `já há um servidor em ${base}: escolha outra SMOKE_PORT`);
  const token = `smoke-${randomBytes(8).toString("hex")}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-xadrez-smoke-"));
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  assert(fs.existsSync(tsxCli), `tsx não encontrado em ${tsxCli} (rode npm install)`);
  console.log(`[smoke] subindo servidor próprio em ${base} (DATA_DIR=${dataDir}, MCP_TOKEN aleatório)`);
  const child = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "src", "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MCP_TOKEN: token,
      ADMIN_TOKEN: "",
      PUBLIC_URL: "",
      ALLOWED_HOSTS: ".smoke-tunnel.example",
      RUNTIME: "node",
      BOT_AUTORESUME: "0",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(`[server] ${d.toString()}`);
  });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new SmokeError(`servidor terminou antes de subir (exit ${child.exitCode})`);
    if (await isUp(base)) return { base, token, child, dataDir };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new SmokeError("servidor não subiu em 30 s");
}

/* ------------------------------------------------------------------ */
/* Helpers MCP / REST                                                  */
/* ------------------------------------------------------------------ */

/**
 * Conecta um cliente MCP. Com token: `via: "query"` usa `?token=` na URL (como os conectores do
 * Claude.ai/ChatGPT); `via: "header"` usa `Authorization: Bearer`.
 */
async function connect(
  srv: SmokeServer,
  name: string,
  via: "query" | "header" = "header",
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const url = new URL(`${srv.base}/mcp`);
  if (srv.token && via === "query") url.searchParams.set("token", srv.token);
  const requestInit = srv.token && via === "header" ? { headers: { Authorization: `Bearer ${srv.token}` } } : undefined;
  const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(transport);
  assert(transport.sessionId, "servidor não devolveu Mcp-Session-Id");
  console.log(`[${name}] conectado (${srv.token ? `token via ${via}` : "sem token"}); sessão ${transport.sessionId.slice(0, 8)}`);
  return { client, transport };
}

async function call(client: Client, label: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS })) as ToolResult;
  console.log(`[${label}] ${name}(${JSON.stringify(args)})${r.isError ? " => ERRO" : ""}: ${headline(r)}`);
  return r;
}

function stateOf(r: ToolResult): GameState {
  assert(r.structuredContent, "resposta sem structuredContent");
  return r.structuredContent as unknown as GameState;
}

function eventOf(r: ToolResult): TurnEvent & { state: GameState } {
  assert(r.structuredContent, "resposta sem structuredContent");
  return r.structuredContent as unknown as TurnEvent & { state: GameState };
}

async function rest<T>(base: string, method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  return { status: res.status, json };
}

async function humanMove(base: string, move: string): Promise<GameState> {
  const { status, json } = await rest<GameState & { error?: string }>(base, "POST", "/api/move", { move });
  assert(status === 200, `humano jogar ${move} falhou (${status}): ${json.error ?? ""}`);
  console.log(`[humano] jogou ${move} (ply ${json.ply})`);
  return json;
}

/* ------------------------------------------------------------------ */
/* Cenário 1: humano (REST) vs LLM (MCP)                               */
/* ------------------------------------------------------------------ */

async function scenarioHumanVsLlm(srv: SmokeServer): Promise<void> {
  const base = srv.base;
  console.log("\n=== Cenário 1: humano (brancas, REST) vs LLM (pretas, MCP) ===");
  const { client, transport } = await connect(srv, "LLM", "query");
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    console.log(`[LLM] tools: ${names.join(", ")}`);
    for (const t of ["new_game", "join_game", "get_state", "make_move", "wait_for_turn", "comment", "highlight", "takeback", "end_game", "leave_game"]) {
      assert(names.includes(t), `tool ${t} ausente`);
    }
    assert(tools.tools.every((t) => t.outputSchema), "alguma tool sem outputSchema");

    const prompts = await client.listPrompts();
    assert(prompts.prompts.some((p) => p.name === "chess_teacher"), "prompt chess_teacher ausente");
    const prompt = await client.getPrompt({ name: "chess_teacher", arguments: { student_level: "beginner" } });
    assert(prompt.messages[0]?.content.type === "text", "prompt sem texto");

    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    for (const u of ["xadrez://game/state", "xadrez://game/pgn", "xadrez://game/state.json"]) assert(uris.includes(u), `recurso ${u} ausente`);

    // Nova partida: LLM de pretas contra humano. Num servidor recém-subido as pretas estão
    // "Aguardando MCP": sem confirm, new_game recusa (e manda usar join_game).
    if (srv.child) {
      const refused = await call(client, "LLM", "new_game", { my_color: "black", my_name: "Smoke LLM", opponent_name: "Humano" });
      assert(refused.isError === true && textOf(refused).includes("new_game recusado"), "new_game sem confirm deveria recusar");
      assert(textOf(refused).includes("join_game"), "recusa de new_game deveria sugerir join_game");
    }
    const created = await call(client, "LLM", "new_game", { my_color: "black", my_name: "Smoke LLM", opponent_name: "Humano", confirm: true });
    assert(!created.isError, "new_game falhou");
    assert(stateOf(created).seats.black.kind === "mcp", "LLM não sentou de pretas");
    assert(textOf(created).includes("Chame wait_for_turn"), "texto de próximo passo ausente");

    // Humano joga e4 enquanto a LLM espera.
    const waiting = call(client, "LLM", "wait_for_turn", { timeout_seconds: 30 });
    await new Promise((r) => setTimeout(r, 300));
    await humanMove(base, "e4");
    const ev1 = eventOf(await waiting);
    assert(ev1.event === "opponent_moved", `esperava opponent_moved, veio ${ev1.event}`);
    assert(ev1.opponentMove?.san === "e4", "opponentMove errado");
    assert(ev1.isYourTurn, "isYourTurn deveria ser true");

    // LLM joga e5 com comentário.
    const e5 = await call(client, "LLM", "make_move", { move: "e5", comment: "Disputo o centro de igual para igual.", comment_category: "plan" });
    assert(!e5.isError, "make_move e5 falhou");
    assert(stateOf(e5).lastMove?.comment === "Disputo o centro de igual para igual.", "comentário não gravado no lance");

    // Mensagem do humano chega em wait_for_turn.
    const waitingMsg = call(client, "LLM", "wait_for_turn", { timeout_seconds: 30 });
    await new Promise((r) => setTimeout(r, 300));
    const msg = await rest<GameState>(base, "POST", "/api/message", { text: "por que e5?", to: "black" });
    assert(msg.status === 200, "POST /api/message falhou");
    const evMsg = eventOf(await waitingMsg);
    assert(evMsg.event === "message", `esperava message, veio ${evMsg.event}`);
    assert(evMsg.messages[0]?.text === "por que e5?", "mensagem não entregue");

    // Comentário e destaque.
    const c = await call(client, "LLM", "comment", { text: "Repare que o peão e5 controla d4 e f4.", category: "lesson", highlight: { squares: ["d4", "f4"] } });
    assert(!c.isError, "comment falhou");
    const h = await call(client, "LLM", "highlight", { arrows: [{ from: "e5", to: "d4", color: "green" }], squares: [{ square: "e5", color: "yellow" }] });
    assert(!h.isError, "highlight falhou");
    assert(stateOf(h).highlight?.arrows.length === 1, "seta não registrada");

    // Lance ilegal / fora da vez.
    const illegalTurn = await call(client, "LLM", "make_move", { move: "Nc6" });
    assert(illegalTurn.isError === true, "make_move fora da vez deveria ser isError");
    await humanMove(base, "Nf3");
    const illegal = await call(client, "LLM", "make_move", { move: "Nf9" });
    assert(illegal.isError === true, "lance ilegal deveria ser isError");
    assert(/Lances legais agora \(\d+\)/.test(textOf(illegal)), "erro sem lista de lances legais");

    // Takeback de 2 meio-lances (Nf3 e e5) e depois volta ao início.
    const tb = await call(client, "LLM", "takeback", { plies: 2 });
    assert(!tb.isError && stateOf(tb).ply === 1, "takeback não voltou para ply 1");
    const tb2 = await call(client, "LLM", "takeback", { plies: 1 });
    assert(stateOf(tb2).ply === 0, "takeback não voltou para ply 0");

    // Mate do Pastor completo: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#
    const pairs: [string, string][] = [["e4", "e5"], ["Bc4", "Nc6"], ["Qh5", "Nf6"]];
    for (const [w, b] of pairs) {
      const waitW = call(client, "LLM", "wait_for_turn", { timeout_seconds: 30 });
      await new Promise((r) => setTimeout(r, 100));
      await humanMove(base, w);
      const ev = eventOf(await waitW);
      assert(ev.event === "opponent_moved" && ev.opponentMove?.san === w, `esperava opponent_moved ${w}`);
      const r = await call(client, "LLM", "make_move", { move: b });
      assert(!r.isError, `make_move ${b} falhou`);
    }
    const waitMate = call(client, "LLM", "wait_for_turn", { timeout_seconds: 30 });
    await new Promise((r) => setTimeout(r, 100));
    const final = await humanMove(base, "Qxf7#");
    assert(final.status === "finished" && final.result === "1-0" && final.endReason === "checkmate", "mate não detectado");
    const evOver = eventOf(await waitMate);
    assert(evOver.event === "game_over", `esperava game_over, veio ${evOver.event}`);
    assert(evOver.state.result === "1-0", "resultado errado no evento");
    assert(textOf(await call(client, "LLM", "get_state")).includes("encerrada"), "get_state não mostra partida encerrada");

    // PGN via REST e recurso MCP.
    const pgnRes = await fetch(`${base}/api/pgn`);
    const pgn = await pgnRes.text();
    assert(pgn.includes("Qxf7#") && pgn.includes('[Result "1-0"]'), "PGN incompleto");
    const resource = await client.readResource({ uri: "xadrez://game/pgn" });
    const rc = resource.contents[0] as { text?: string };
    assert(rc.text?.includes("Qxf7#"), "recurso PGN incompleto");
    console.log(`[REST] PGN ok (${pgn.split("\n").length} linhas); partidas arquivadas: ${JSON.stringify((await rest(base, "GET", "/api/games")).json)}`);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Cenário 2: LLM vs LLM                                               */
/* ------------------------------------------------------------------ */

async function scenarioLlmVsLlm(srv: SmokeServer): Promise<void> {
  console.log("\n=== Cenário 2: LLM A (brancas) vs LLM B (pretas) ===");
  const a = await connect(srv, "A", "header");
  const b = await connect(srv, "B", "query");
  try {
    // A partida do cenário 1 terminou em mate: new_game não precisa de confirm.
    const created = await call(a.client, "A", "new_game", { my_color: "white", opponent: "llm", my_name: "LLM A" });
    assert(!created.isError && stateOf(created).status === "waiting", "new_game(opponent: llm) deveria ficar waiting");
    assert(textOf(created).includes('join_game(color: "black")'), "texto de espera por outra LLM ausente");

    const waitA = call(a.client, "A", "wait_for_turn", { timeout_seconds: 30 });
    await new Promise((r) => setTimeout(r, 300));
    // Sem color: join_game escolhe o assento que espera uma LLM (pretas).
    const joined = await call(b.client, "B", "join_game", { my_name: "LLM B" });
    assert(stateOf(joined).seats.black.name === "LLM B", "join_game sem color deveria sentar B nas pretas");
    assert(!joined.isError && stateOf(joined).status === "active", "join_game não ativou a partida");
    const evA = eventOf(await waitA);
    assert(evA.event === "your_turn", `A esperava your_turn, veio ${evA.event}`);

    const moves: [string, string][] = [["e4", "e5"], ["Nf3", "Nc6"], ["Bb5", "a6"], ["Ba4", "Nf6"]];
    for (const [wm, bm] of moves) {
      const waitB = call(b.client, "B", "wait_for_turn", { timeout_seconds: 30 });
      await new Promise((r) => setTimeout(r, 50));
      const rw = await call(a.client, "A", "make_move", { move: wm, comment: `Jogo ${wm}.` });
      assert(!rw.isError, `A: ${wm} falhou`);
      const evB = eventOf(await waitB);
      assert(evB.event === "opponent_moved" && evB.opponentMove?.san === wm, `B esperava ${wm}`);
      const waitA2 = call(a.client, "A", "wait_for_turn", { timeout_seconds: 30 });
      await new Promise((r) => setTimeout(r, 50));
      const rb = await call(b.client, "B", "make_move", { move: bm });
      assert(!rb.isError, `B: ${bm} falhou`);
      const evA2 = eventOf(await waitA2);
      assert(evA2.event === "opponent_moved" && evA2.opponentMove?.san === bm, `A esperava ${bm}`);
    }
    const stA = stateOf(await call(a.client, "A", "get_state"));
    assert(stA.ply === 8 && stA.history.map((m) => m.san).join(" ") === "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6", "histórico LLM vs LLM errado");
    // B enxerga os últimos comentários de A no estado.
    assert(textOf(await call(b.client, "B", "get_state")).includes("Últimos comentários de LLM A"), "comentários do oponente ausentes");

    const ended = await call(a.client, "A", "end_game", { how: "draw" });
    assert(!ended.isError && stateOf(ended).result === "1/2-1/2", "end_game draw falhou");
    const evBOver = eventOf(await call(b.client, "B", "wait_for_turn", { timeout_seconds: 5 }));
    assert(evBOver.event === "game_over", `B esperava game_over, veio ${evBOver.event}`);
    await call(a.client, "A", "leave_game");
    await call(b.client, "B", "leave_game");
  } finally {
    await a.transport.terminateSession().catch(() => undefined);
    await b.transport.terminateSession().catch(() => undefined);
    await a.client.close().catch(() => undefined);
    await b.client.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Cenário 0: guardas HTTP (token, Host, /.well-known, sessão velha)   */
/* ------------------------------------------------------------------ */

function rawRequest(base: string, method: string, pathname: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path: pathname,
        headers: {
          accept: "application/json, text/event-stream",
          ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout em ${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function scenarioHttpGuards(srv: SmokeServer): Promise<void> {
  console.log("\n=== Cenário 0: token, Host, /.well-known e initialize com sessão velha ===");
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-raw", version: "0.1.0" } },
  };
  const host = new URL(srv.base).host;
  const auth: Record<string, string> = srv.token ? { authorization: `Bearer ${srv.token}` } : {};
  if (srv.token) {
    const noToken = await rawRequest(srv.base, "POST", "/mcp", { host }, init);
    assert(noToken.status === 401 && String(noToken.headers["www-authenticate"] ?? "").includes("Bearer"), `sem token deveria dar 401 (veio ${noToken.status})`);
    const wrong = await rawRequest(srv.base, "POST", "/mcp?token=errado", { host }, init);
    assert(wrong.status === 401, `?token errado deveria dar 401 (veio ${wrong.status})`);
    console.log("[http] /mcp sem token / token errado => 401 ok");
  }
  const stale = await rawRequest(srv.base, "POST", "/mcp", { host, ...auth, "mcp-session-id": "sessao-velha-de-antes-do-restart" }, init);
  const sid = stale.headers["mcp-session-id"];
  assert(stale.status === 200 && sid && sid !== "sessao-velha-de-antes-do-restart", `initialize com Mcp-Session-Id velho deveria abrir sessão nova (veio ${stale.status})`);
  await rawRequest(srv.base, "DELETE", "/mcp", { host, ...auth, "mcp-session-id": String(sid), "mcp-protocol-version": "2025-06-18" });
  console.log("[http] initialize com sessão velha => sessão nova ok");

  if (srv.child) {
    const evil = await rawRequest(srv.base, "POST", "/mcp", { host: "evil.example", ...auth }, init);
    assert(evil.status === 403 && evil.body.includes("ALLOWED_HOSTS"), `Host evil.example deveria dar 403 (veio ${evil.status})`);
    const evilApi = await rawRequest(srv.base, "GET", "/api/state", { host: "evil.example:80" });
    assert(evilApi.status === 403, `Host evil.example em /api deveria dar 403 (veio ${evilApi.status})`);
    const tunnel = await rawRequest(srv.base, "GET", "/api/health", { host: "abc.smoke-tunnel.example" });
    assert(tunnel.status === 200, `Host do túnel (ALLOWED_HOSTS=.smoke-tunnel.example) deveria passar (veio ${tunnel.status})`);
    console.log("[http] Host: evil.example => 403; *.smoke-tunnel.example => 200 ok");
  }
  const wk = await rawRequest(srv.base, "GET", "/.well-known/oauth-protected-resource", { host, accept: "text/html,*/*" });
  assert(wk.status === 404 && String(wk.headers["content-type"] ?? "").includes("json"), `/.well-known deveria dar 404 JSON (veio ${wk.status})`);
  console.log("[http] /.well-known => 404 JSON ok");

  if (srv.child) {
    const hello = await wsHello(srv.base);
    const info = hello.server;
    assert(info.mcpAuth === "token", `ServerInfo.mcpAuth deveria ser "token" (veio ${String(info.mcpAuth)})`);
    assert(info.runtime === "node", `ServerInfo.runtime deveria ser "node" (veio ${String(info.runtime)})`);
    assert(!JSON.stringify(hello).includes(srv.token), "o token vazou no hello do WebSocket");
    let rejected = false;
    try {
      await wsHello(srv.base, "evil.example");
    } catch {
      rejected = true;
    }
    assert(rejected, "upgrade do WebSocket com Host evil.example deveria ser recusado");
    console.log("[ws] hello: mcpAuth=token runtime=node; Host evil.example recusado ok");
  }
}

/** Abre o /ws, devolve a mensagem `hello` e fecha. */
function wsHello(base: string, host?: string): Promise<{ server: ServerInfo }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, host ? { headers: { host } } : undefined);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new SmokeError("WebSocket sem hello em 5 s"));
    }, 5000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(data)) as { server: ServerInfo });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      socket.terminate();
      reject(new SmokeError(`upgrade recusado (${res.statusCode})`));
    });
  });
}

async function main(): Promise<void> {
  const srv = await ensureServer();
  const { child, dataDir } = srv;
  let ok = false;
  try {
    await scenarioHttpGuards(srv);
    await scenarioHumanVsLlm(srv);
    await scenarioLlmVsLlm(srv);
    ok = true;
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  if (ok) console.log("\nOK");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\nFALHOU: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
