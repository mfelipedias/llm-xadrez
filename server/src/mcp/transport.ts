/**
 * Rota /mcp (POST/GET/DELETE) com sessões Streamable HTTP, seguindo o exemplo
 * `jsonResponseStreamableHttp` do SDK — mas com SSE padrão (sem enableJsonResponse),
 * porque `wait_for_turn` é longa. Ver docs/03-servidor.md, "MCP".
 *
 * - Autenticação opcional (MCP_TOKEN): `Authorization: Bearer <token>` ou `?token=<token>` na
 *   URL (conectores do Claude.ai/ChatGPT não deixam configurar headers). Comparação em tempo
 *   constante; o token nunca é logado.
 * - Varredura de ociosidade: sessões sem requisição há `sessionIdleMs` (default 30 min) são
 *   fechadas — nunca enquanto têm um `wait_for_turn` pendente.
 * - `initialize` com um Mcp-Session-Id velho (servidor reiniciou, sessão varrida) abre uma sessão
 *   nova em vez de devolver 404.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GameStore } from "../game/store.js";
import { createMcpServer, type McpServerOptions, type SessionRef } from "./server.js";
import { createLogger } from "../log.js";

const log = createLogger("mcp");

/** Default de `sessionIdleMs`: 30 min sem requisição => a sessão é fechada. */
export const DEFAULT_MCP_SESSION_IDLE_MS = 30 * 60_000;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ref: SessionRef;
  /** Epoch ms da última requisição HTTP desta sessão. */
  lastRequestAt: number;
}

export interface McpTransportOptions extends McpServerOptions {
  /** Se definido, exige `Authorization: Bearer <token>` ou `?token=<token>`. */
  token?: string;
  /** Fecha sessões sem requisição há este tempo (ms). Default 30 min; 0 desliga. */
  sessionIdleMs?: number;
  /** Intervalo da varredura (ms). Default: min(60 s, sessionIdleMs / 4), mínimo 1 s. */
  sweepIntervalMs?: number;
  /** Relógio injetável (testes). */
  now?: () => number;
}

export interface McpRouterHandle {
  router: Router;
  sessionIds(): string[];
  /** Roda a varredura de ociosidade agora; devolve quantas sessões foram fechadas. */
  sweepIdle(): Promise<number>;
  closeAll(): Promise<void>;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Compara dois segredos em tempo constante (hash antes para não vazar o tamanho). */
export function safeTokenEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** Extrai o token da requisição: header Authorization (Bearer) ou query `token`. */
function tokenFrom(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  // Lido da URL crua para não depender do parser de query do express.
  const qs = (req.originalUrl ?? req.url ?? "").split("?")[1];
  if (qs) {
    const value = new URLSearchParams(qs).get("token");
    if (value) return value;
  }
  return undefined;
}

export function createMcpRouter(store: GameStore, opts: McpTransportOptions): McpRouterHandle {
  const router = Router();
  const sessions = new Map<string, SessionEntry>();
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.sessionIdleMs ?? DEFAULT_MCP_SESSION_IDLE_MS;

  if (opts.token) {
    const expected = opts.token;
    router.use((req: Request, res: Response, next: NextFunction) => {
      const given = tokenFrom(req);
      if (given !== undefined && safeTokenEqual(given, expected)) {
        next();
        return;
      }
      res.setHeader("WWW-Authenticate", 'Bearer realm="llm-xadrez"');
      jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid token (use 'Authorization: Bearer <MCP_TOKEN>' or '?token=<MCP_TOKEN>' in the URL)");
    });
  }

  const sessionIdOf = (req: Request): string | undefined => {
    const raw = req.headers["mcp-session-id"];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const markSeen = (entry: SessionEntry): void => {
    entry.lastRequestAt = now();
    if (entry.ref.id) store.touchSession(entry.ref.id);
  };

  const createSession = async (): Promise<SessionEntry> => {
    const ref: SessionRef = { id: "" };
    const entry: Partial<SessionEntry> = { ref, lastRequestAt: now() };
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
        log.info(`sessão fechada ${ref.id.slice(0, 8)} (total: ${sessions.size})`);
      }
      // Sempre: o store descarta a entrada e libera waiters (mesmo após closeAll).
      if (ref.id) store.sessionClosed(ref.id);
    };
    transport.onerror = (err) => log.warn(`erro no transporte ${ref.id.slice(0, 8) || "(nova)"}: ${err.message}`);
    const server = createMcpServer(store, ref, opts);
    entry.transport = transport;
    entry.server = server;
    await server.connect(transport);
    return entry as SessionEntry;
  };

  const closeEntry = async (entry: SessionEntry): Promise<void> => {
    try {
      await entry.server.close();
    } catch (err) {
      log.warn(`erro fechando sessão ${entry.ref.id.slice(0, 8)}: ${(err as Error).message}`);
    }
  };

  router.post("/", async (req, res) => {
    try {
      const sessionId = sessionIdOf(req);
      // initialize sempre abre sessão nova — inclusive com um Mcp-Session-Id velho (restart do
      // servidor, sessão varrida por ociosidade): o cliente está justamente tentando reconectar.
      if (isInitializeRequest(req.body)) {
        if (sessionId) {
          const stale = sessions.has(sessionId) ? "ainda aberta" : "desconhecida";
          log.debug(`initialize com Mcp-Session-Id ${stale} (${sessionId.slice(0, 8)}): abrindo sessão nova`);
          delete req.headers["mcp-session-id"];
        }
        const entry = await createSession();
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        markSeen(existing);
        await existing.transport.handleRequest(req, res, req.body);
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
    markSeen(existing);
    try {
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      log.error(`erro tratando ${req.method} /mcp: ${(err as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  };

  router.get("/", handleExisting);
  router.delete("/", handleExisting);

  const sweepIdle = async (): Promise<number> => {
    if (idleMs <= 0) return 0;
    const t = now();
    const stale = [...sessions.values()].filter((e) => t - e.lastRequestAt > idleMs && !store.hasWaiter(e.ref.id));
    for (const entry of stale) {
      log.info(`sessão ${entry.ref.id.slice(0, 8)} ociosa há ${Math.round((t - entry.lastRequestAt) / 60_000)} min: fechando`);
      // Remove antes de fechar: uma requisição concorrente já recebe 404 e reinicializa.
      sessions.delete(entry.ref.id);
      await closeEntry(entry);
      store.sessionClosed(entry.ref.id);
    }
    return stale.length;
  };

  let sweeper: NodeJS.Timeout | null = null;
  if (idleMs > 0) {
    const every = opts.sweepIntervalMs ?? Math.max(1000, Math.min(60_000, Math.floor(idleMs / 4)));
    sweeper = setInterval(() => void sweepIdle(), every);
    sweeper.unref();
  }

  return {
    router,
    sessionIds: () => [...sessions.keys()],
    sweepIdle,
    async closeAll() {
      if (sweeper) {
        clearInterval(sweeper);
        sweeper = null;
      }
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(entries.map((e) => closeEntry(e)));
    },
  };
}
