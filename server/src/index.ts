/**
 * Bootstrap: Express (createMcpExpressApp) + REST /api + MCP /mcp + WebSocket /ws + UI estática.
 * Ver docs/03-servidor.md, "Bootstrap".
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { ServerInfo } from "../../shared/types.js";
import { config, ROOT_DIR } from "./config.js";
import { createLogger } from "./log.js";
import { GameStore } from "./game/store.js";
import { attachPersistence } from "./game/persist.js";
import { createApiRouter } from "./http/api.js";
import { attachWebSocket } from "./http/ws.js";
import { createMcpRouter } from "./mcp/transport.js";

const log = createLogger("http");

const store = new GameStore({ defaultHumanName: config.humanName });
const persistence = attachPersistence(store, config.dataDir);
const serverInfo = (): ServerInfo => store.serverInfo(config.version, config.mcpUrl);

const app = createMcpExpressApp({ host: config.host });

app.use("/api", createApiRouter({ store, persistence, serverInfo, defaultHumanName: config.humanName }));

const mcp = createMcpRouter(store, {
  version: config.version,
  lang: config.lang,
  defaultHumanName: config.humanName,
  token: config.mcpToken || undefined,
});
app.use("/mcp", mcp.router);

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
<p>Claude Code: <code>claude mcp add --transport http xadrez ${esc(config.mcpUrl)}</code></p>
<p>Estado atual (JSON): <a href="/api/state">/api/state</a> · Saúde: <a href="/api/health">/api/health</a> · PGN: <a href="/api/pgn">/api/pgn</a></p>
</body></html>`;
}

const httpServer = app.listen(config.port, config.host, () => {
  const b = config.baseUrl;
  const lines = [
    "",
    "  ♞ LLM Xadrez v" + config.version,
    `  UI (tabuleiro):   ${b}${hasDist ? "" : "   (web/dist ausente: rode `npm run build` ou use `npm run dev`)"}`,
    `  MCP (LLMs):       ${config.mcpUrl}${config.mcpToken ? "   (protegido por MCP_TOKEN)" : ""}`,
    `  API REST:         ${b}/api/state`,
    `  WebSocket:        ${b.replace(/^http/, "ws")}/ws`,
    `  Dados:            ${config.dataDir}`,
    "",
    "  Conectar clientes MCP:",
    `    Claude Code:     claude mcp add --transport http xadrez ${config.mcpUrl}`,
    "    Claude Desktop:  (claude_desktop_config.json)",
    `      { "mcpServers": { "xadrez": { "command": "npx", "args": ["-y", "mcp-remote", "${config.mcpUrl}", "--allow-http"] } } }`,
    "",
  ];
  console.log(lines.join("\n"));
});
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") log.error(`porta ${config.port} já está em uso (defina PORT no .env).`);
  else log.error(`falha ao subir o servidor: ${err.message}`);
  process.exit(1);
});

const ws = attachWebSocket(httpServer, store, serverInfo);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} recebido: encerrando...`);
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try {
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
