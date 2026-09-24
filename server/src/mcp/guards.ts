/**
 * Guardas HTTP. Proteção contra DNS rebinding: valida o header `Host` de toda requisição (/api, /mcp, UI e o
 * upgrade do /ws) contra uma lista de hosts aceitos. Substitui a validação do
 * `createMcpExpressApp` do SDK, que só protege quando o bind é em localhost (em 0.0.0.0 — Docker —
 * aceitava qualquer Host) e não aceita o host de um túnel (cloudflared manda
 * `Host: xxx.trycloudflare.com`).
 *
 * Como no SDK, a comparação ignora a porta (`localhost:3939` e `localhost:5173` valem igual).
 * Entradas aceitas em ALLOWED_HOSTS:
 *  - `exemplo.com`, `192.168.0.10`, `[::1]` (ou `::1`), com ou sem porta/esquema (`https://x.com:8443/`);
 *  - `.trycloudflare.com` — curinga: o domínio e qualquer subdomínio;
 *  - `*` — aceita qualquer Host (desliga a proteção; só com MCP_TOKEN ou em rede confiável).
 */
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../log.js";

const log = createLogger("http");

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", ""]);

export interface HostPolicyInput {
  /** URL pública (PUBLIC_URL) ou a baseUrl derivada; o host dela é aceito. */
  baseUrl?: string;
  /** Endereço de bind (HOST); aceito quando é um IP/nome específico (não 0.0.0.0/::). */
  bindHost?: string;
  /** ALLOWED_HOSTS. */
  extra?: string[];
}

export interface HostPolicy {
  /** true se o header Host é aceito. */
  allows(hostHeader: string | undefined): boolean;
  /** Entradas normalizadas (para o log de inicialização). */
  readonly entries: string[];
  readonly allowAny: boolean;
}

/**
 * Normaliza uma entrada de configuração para um hostname minúsculo, sem porta.
 * Devolve `null` se a entrada não é um host válido. Preserva o ponto inicial dos curingas.
 */
export function normalizeHostEntry(raw: string): string | null {
  let entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (entry === "*") return "*";
  const wildcard = entry.startsWith(".") || entry.startsWith("*.");
  if (wildcard) entry = entry.replace(/^\*?\./, "");
  // IPv6 sem colchetes (ex.: "::1") → "[::1]".
  if (!entry.includes("[") && (entry.match(/:/g) ?? []).length > 1 && !entry.includes("/")) entry = `[${entry}]`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(entry) ? entry : `http://${entry}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;
  return wildcard ? `.${hostname}` : hostname;
}

/** Hostname (sem porta, minúsculo) de um header Host; `null` se ausente ou inválido. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    const hostname = new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

/** Monta a lista de hosts aceitos: loopback + host da PUBLIC_URL + host do bind + ALLOWED_HOSTS. */
export function buildHostPolicy(input: HostPolicyInput): HostPolicy {
  const set = new Set<string>(LOOPBACK_HOSTS);
  if (input.baseUrl) {
    const h = normalizeHostEntry(input.baseUrl);
    if (h) set.add(h);
  }
  if (input.bindHost && !WILDCARD_BINDS.has(input.bindHost.trim())) {
    const h = normalizeHostEntry(input.bindHost);
    if (h) set.add(h);
  }
  for (const raw of input.extra ?? []) {
    const h = normalizeHostEntry(raw);
    if (h) set.add(h);
    else log.warn(`ALLOWED_HOSTS: entrada ignorada (host inválido): ${JSON.stringify(raw)}`);
  }
  const allowAny = set.has("*");
  const exact = new Set([...set].filter((h) => !h.startsWith(".") && h !== "*"));
  const suffixes = [...set].filter((h) => h.startsWith("."));
  return {
    entries: [...set],
    allowAny,
    allows(hostHeader) {
      const hostname = hostnameOf(hostHeader);
      if (!hostname) return false;
      if (allowAny || exact.has(hostname)) return true;
      return suffixes.some((s) => hostname.endsWith(s) || hostname === s.slice(1));
    },
  };
}

/** Mensagem de erro (pt-BR) dizendo como liberar o host. */
export function hostRejectionMessage(hostHeader: string | undefined): string {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return "Header Host ausente ou inválido.";
  const suggestion = hostname.includes(".") ? `.${hostname.split(".").slice(-2).join(".")}` : hostname;
  return (
    `Host não permitido: "${hostname}" (proteção contra DNS rebinding). ` +
    `Se você acessa o servidor por esse endereço (túnel, IP da rede, domínio), defina PUBLIC_URL=https://${hostname} ` +
    `ou inclua-o em ALLOWED_HOSTS (ex.: ALLOWED_HOSTS=${hostname}, ou ${suggestion} para aceitar os subdomínios) e reinicie o servidor.`
  );
}

/** Middleware express: 403 JSON (formato JSON-RPC, como o SDK) para Host fora da lista. */
export function hostValidationMiddleware(policy: HostPolicy): (req: Request, res: Response, next: NextFunction) => void {
  const warned = new Set<string>();
  return (req, res, next) => {
    if (policy.allows(req.headers.host)) {
      next();
      return;
    }
    const message = hostRejectionMessage(req.headers.host);
    const key = hostnameOf(req.headers.host) ?? "(ausente)";
    if (!warned.has(key) && warned.size < 100) {
      warned.add(key);
      log.warn(`requisição recusada: Host "${key}" não está na lista (defina PUBLIC_URL ou ALLOWED_HOSTS)`);
    }
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  };
}

/** Para o upgrade do WebSocket (`verifyClient` do `ws`). */
export function allowsUpgrade(policy: HostPolicy, req: IncomingMessage): boolean {
  return policy.allows(req.headers.host);
}

/**
 * `/.well-known/*` → 404 JSON. Sem isto a rota cairia no fallback da SPA (index.html com 200),
 * e clientes MCP que fazem descoberta OAuth (`/.well-known/oauth-protected-resource`,
 * `oauth-authorization-server`) achariam que há algo ali. Montar antes do fallback da SPA.
 */
export function wellKnownNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found: este servidor não publica /.well-known (sem OAuth; para proteger o /mcp use MCP_TOKEN)." });
}
