/**
 * WebSocket /ws: broadcast do estado para o navegador. Ver docs/03-servidor.md, "WebSocket".
 *  - ao conectar: { type: "hello", state, server }
 *  - a cada "change" do store: { type: "state", state }
 *  - a cada "server" do store (sessões MCP, lastSeenAt): { type: "server", server } (throttle 500 ms)
 *  - ping/pong a cada 30 s
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { GameState, ServerInfo, WsServerMessage } from "../../../shared/types.js";
import type { GameStore } from "../game/store.js";
import { createLogger } from "../log.js";

const log = createLogger("ws");

export interface WsOptions {
  path?: string;
  pingIntervalMs?: number;
  serverThrottleMs?: number;
}

export interface WsHandle {
  close(): void;
  clientCount(): number;
}

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

export function attachWebSocket(
  httpServer: HttpServer,
  store: GameStore,
  serverInfo: () => ServerInfo,
  opts: WsOptions = {},
): WsHandle {
  const wss = new WebSocketServer({ server: httpServer, path: opts.path ?? "/ws" });
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const serverThrottleMs = opts.serverThrottleMs ?? 500;

  const broadcast = (msg: WsServerMessage): void => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  const onChange = (state: GameState): void => {
    broadcast({ type: "state", state });
  };

  let serverTimer: NodeJS.Timeout | null = null;
  const onServer = (): void => {
    if (serverTimer) return;
    serverTimer = setTimeout(() => {
      serverTimer = null;
      broadcast({ type: "server", server: serverInfo() });
    }, serverThrottleMs);
  };

  store.on("change", onChange);
  store.on("server", onServer);

  wss.on("connection", (socket: AliveSocket, req) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("error", (err) => log.warn(`erro no socket: ${err.message}`));
    const hello: WsServerMessage = { type: "hello", state: store.getState(), server: serverInfo() };
    socket.send(JSON.stringify(hello));
    log.debug(`navegador conectado (${req.socket.remoteAddress ?? "?"}); clientes: ${wss.clients.size}`);
    socket.on("close", () => log.debug(`navegador desconectado; clientes: ${wss.clients.size}`));
  });

  const pingTimer = setInterval(() => {
    for (const client of wss.clients as Set<AliveSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, pingIntervalMs);

  return {
    close() {
      clearInterval(pingTimer);
      if (serverTimer) clearTimeout(serverTimer);
      store.off("change", onChange);
      store.off("server", onServer);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
    clientCount() {
      return wss.clients.size;
    },
  };
}
