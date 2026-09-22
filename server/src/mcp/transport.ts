/**
 * Rota /mcp (POST/GET/DELETE) com sessões Streamable HTTP, seguindo o exemplo
 * `jsonResponseStreamableHttp` do SDK — mas com SSE padrão (sem enableJsonResponse),
 * porque `wait_for_turn` é longa. Ver docs/03-servidor.md, "MCP".
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GameStore } from "../game/store.js";
import { createMcpServer, type McpServerOptions, type SessionRef } from "./server.js";
import { createLogger } from "../log.js";

const log = createLogger("mcp");

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ref: SessionRef;
}

export interface McpTransportOptions extends McpServerOptions {
  /** Se definido, exige `Authorization: Bearer <token>`. */
  token?: string;
}

export interface McpRouterHandle {
  router: Router;
  sessionIds(): string[];
  closeAll(): Promise<void>;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createMcpRouter(store: GameStore, opts: McpTransportOptions): McpRouterHandle {
  const router = Router();
  const sessions = new Map<string, SessionEntry>();

  if (opts.token) {
    const expected = `Bearer ${opts.token}`;
    router.use((req, res, next) => {
      if (req.headers.authorization === expected) {
        next();
        return;
      }
      res.setHeader("WWW-Authenticate", 'Bearer realm="llm-xadrez"');
      jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid bearer token");
    });
  }

  const sessionIdOf = (req: Request): string | undefined => {
    const raw = req.headers["mcp-session-id"];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const createSession = async (): Promise<SessionEntry> => {
    const ref: SessionRef = { id: "" };
    const entry: Partial<SessionEntry> = { ref };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        ref.id = sessionId;
        sessions.set(sessionId, entry as SessionEntry);
        store.sessionOpened(sessionId);
        log.info(`sessão iniciada ${sessionId.slice(0, 8)} (total: ${sessions.size})`);
      },
      onsessionclosed: (sessionId) => {
        log.debug(`sessão ${sessionId.slice(0, 8)} encerrada pelo cliente (DELETE)`);
      },
    });
    transport.onclose = () => {
      if (ref.id && sessions.has(ref.id)) {
        sessions.delete(ref.id);
        store.sessionClosed(ref.id);
        log.info(`sessão fechada ${ref.id.slice(0, 8)} (total: ${sessions.size})`);
      }
    };
    transport.onerror = (err) => log.warn(`erro no transporte ${ref.id.slice(0, 8) || "(nova)"}: ${err.message}`);
    const server = createMcpServer(store, ref, opts);
    entry.transport = transport;
    entry.server = server;
    await server.connect(transport);
    return entry as SessionEntry;
  };

  router.post("/", async (req, res) => {
    try {
      const sessionId = sessionIdOf(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const entry = await createSession();
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId) {
        jsonRpcError(res, 404, -32001, "Session not found: reconnect (initialize) to start a new session");
        return;
      }
      jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
    } catch (err) {
      log.error(`erro tratando POST /mcp: ${(err as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  const handleExisting = async (req: Request, res: Response): Promise<void> => {
    const sessionId = sessionIdOf(req);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!existing) {
      jsonRpcError(res, sessionId ? 404 : 400, -32000, sessionId ? "Session not found" : "Bad Request: missing Mcp-Session-Id");
      return;
    }
    try {
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      log.error(`erro tratando ${req.method} /mcp: ${(err as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  };

  router.get("/", handleExisting);
  router.delete("/", handleExisting);

  return {
    router,
    sessionIds: () => [...sessions.keys()],
    async closeAll() {
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(entries.map((e) => e.transport.close()));
    },
  };
}
