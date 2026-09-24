/**
 * Bootstrap: Express (createMcpExpressApp) + REST /api + MCP /mcp + WebSocket /ws + UI estática.
 * Ver docs/03-servidor.md, "Bootstrap".
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { ServerInfo } from "../../shared/types.js";
import { config, ROOT_DIR } from "./config.js";
import { createLogger } from "./log.js";
import { GameStore } from "./game/store.js";
import { attachPersistence } from "./game/persist.js";
import { createApiRouter } from "./http/api.js";
import { attachWebSocket } from "./http/ws.js";
import { createMcpRouter } from "./mcp/transport.js";
import { allowsUpgrade, buildHostPolicy, hostValidationMiddleware, wellKnownNotFound } from "./mcp/guards.js";
import { ProviderRegistry } from "./bots/providers/registry.js";
import { createFakeProvider } from "./bots/providers/fake.js";
import { BotManager } from "./bots/manager.js";

const log = createLogger("http");

const store = new GameStore({ defaultHumanName: config.humanName, restoreBots: config.botAutoResume });
const persistence = attachPersistence(store, config.dataDir);
const registry = new ProviderRegistry({ file: config.providersFile });
if (config.botFakeProvider) {
  // BOT_FAKE_PROVIDER=1: provedor determinístico em memória, para `npm run smoke:bot` sem rede.
  registry.inject(createFakeProvider({ id: "fake" }), { name: "Fake (determinístico)", toolMode: "native", local: true });
  log.info('BOT_FAKE_PROVIDER: provedor "fake" injetado (modelo "fake-1")');
}
const bots = new BotManager({ store, registry, lang: config.lang });
const serverInfo = (): ServerInfo => ({
  ...store.serverInfo(config.version, config.mcpUrl),
  mcpAuth: config.mcpToken ? "token" : "none",
  runtime: config.inDocker ? "docker" : "node",
  providers: registry.publicList(),
  profiles: registry.profiles(),
  bots: store.botSeats(),
});

// Proteção contra DNS rebinding em todas as rotas (e no upgrade do /ws), em qualquer bind:
// loopback + host da PUBLIC_URL + host do bind + ALLOWED_HOSTS (aceita ".dominio" como curinga).
// Substitui a validação do createMcpExpressApp do SDK, que em 0.0.0.0 não protegia e em
// 127.0.0.1 recusava o Host de um túnel.
const hostPolicy = buildHostPolicy({ baseUrl: config.baseUrl, bindHost: config.host, extra: config.allowedHosts });

const app = express();
app.disable("x-powered-by");
app.use(hostValidationMiddleware(hostPolicy));
app.use(express.json());

app.use(
  "/api",
  createApiRouter({
    store,
    persistence,
    serverInfo,
    defaultHumanName: config.humanName,
    registry,
    bots,
    adminToken: config.adminToken || undefined,
    adminAllowFrom: config.adminAllowFrom,
    inDocker: config.inDocker,
  }),
);

if (config.botAutoResume) bots.autoResume();

const mcp = createMcpRouter(store, {
  version: config.version,
  lang: config.lang,
  defaultHumanName: config.humanName,
  token: config.mcpToken || undefined,
});
app.use("/mcp", mcp.router);

// Descoberta OAuth: 404 JSON em /.well-known (e não o index.html da SPA com 200).
app.use("/.well-known", wellKnownNotFound);

// UI: web/dist se existir; senão uma página mínima explicando como buildar.
const distDir = path.join(ROOT_DIR, "web", "dist");
const indexHtml = path.join(distDir, "index.html");
const hasDist = fs.existsSync(indexHtml);
if (hasDist) {
  app.use(express.static(distDir, { index: "index.html" }));
  app.use((req, res, next) => {
    const p = req.path;
    if (req.method !== "GET" || p.startsWith("/api") || p.startsWith("/mcp") || p.startsWith("/ws") || !req.accepts("html")) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
} else {
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(placeholderPage());
  });
}

function placeholderPage(): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>LLM Xadrez — servidor</title>
<style>body{font-family:system-ui,sans-serif;background:#161a1f;color:#e8e8e8;max-width:720px;margin:48px auto;padding:0 16px;line-height:1.5}
code,pre{background:#0d1014;padding:2px 6px;border-radius:4px}pre{padding:12px;overflow:auto}a{color:#8ab4f8}</style></head>
<body><h1>♞ LLM Xadrez — servidor no ar</h1>
<p>O frontend ainda não foi buildado (<code>web/dist</code> não existe). Para gerar a UI:</p>
<pre>npm run build
npm start</pre>
<p>Em desenvolvimento, use <code>npm run dev</code> e abra <a href="http://localhost:5173">http://localhost:5173</a>.</p>
<h2>Endpoint MCP</h2>
<pre>${esc(config.mcpUrl)}</pre>
<p>Claude Code: <code>claude mcp add -s user --transport http xadrez ${esc(config.mcpUrl)}</code>${
    config.mcpToken ? ` (com MCP_TOKEN: <code>--header "Authorization: Bearer &lt;MCP_TOKEN&gt;"</code>)` : ""
  }</p>
<p>Estado atual (JSON): <a href="/api/state">/api/state</a> · Saúde: <a href="/api/health">/api/health</a> · PGN: <a href="/api/pgn">/api/pgn</a></p>
</body></html>`;
}

const httpServer = app.listen(config.port, config.host, () => {
  const b = config.baseUrl;
  const url = config.mcpUrl;
  const sep = url.includes("?") ? "&" : "?";
  const connect = config.mcpToken
    ? [
        "  Conectar clientes MCP (MCP_TOKEN ativo — troque <MCP_TOKEN> pelo valor do .env):",
        `    Claude Code:     claude mcp add -s user --transport http xadrez ${url} --header "Authorization: Bearer <MCP_TOKEN>"`,
        `    Sem headers:     ${url}${sep}token=<MCP_TOKEN>   (conectores do Claude.ai/ChatGPT)`,
        "    Claude Desktop:  (claude_desktop_config.json)",
        `      { "mcpServers": { "xadrez": { "command": "npx", "args": ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer <MCP_TOKEN>"${url.startsWith("http:") ? ', "--allow-http"' : ""}] } } }`,
      ]
    : [
        "  Conectar clientes MCP:",
        `    Claude Code:     claude mcp add -s user --transport http xadrez ${url}`,
        "    Claude Desktop:  (claude_desktop_config.json)",
        `      { "mcpServers": { "xadrez": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"${url.startsWith("http:") ? ', "--allow-http"' : ""}] } } }`,
      ];
  const hostsLine = hostPolicy.allowAny
    ? "qualquer um (ALLOWED_HOSTS=*: proteção contra DNS rebinding desligada)"
    : hostPolicy.entries.join(", ");
  const lines = [
    "",
    "  ♞ LLM Xadrez v" + config.version,
    `  UI (tabuleiro):   ${b}${hasDist ? "" : "   (web/dist ausente: rode `npm run build` ou use `npm run dev`)"}`,
    `  MCP (LLMs):       ${config.mcpUrl}${config.mcpToken ? "   (protegido por MCP_TOKEN)" : ""}`,
    `  API REST:         ${b}/api/state`,
    `  WebSocket:        ${b.replace(/^http/, "ws")}/ws`,
    `  Dados:            ${config.dataDir}`,
    `  Hosts aceitos:    ${hostsLine}`,
    "                    (outro endereço — túnel, IP da rede? defina PUBLIC_URL ou ALLOWED_HOSTS)",
    "",
    ...connect,
    "",
  ];
  console.log(lines.join("\n"));
});
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") log.error(`porta ${config.port} já está em uso (defina PORT no .env).`);
  else log.error(`falha ao subir o servidor: ${err.message}`);
  process.exit(1);
});

const ws = attachWebSocket(httpServer, store, serverInfo, { verifyClient: (req) => allowsUpgrade(hostPolicy, req) });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} recebido: encerrando...`);
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try {
    bots.stopAll();
    store.dispose();
    await persistence.flush();
    await mcp.closeAll();
    ws.close();
    httpServer.close();
  } catch (err) {
    log.error(`erro ao encerrar: ${(err as Error).message}`);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
