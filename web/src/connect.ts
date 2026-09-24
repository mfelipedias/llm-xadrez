/**
 * Snippets de conexão por cliente MCP, usados pelo onboarding (`ConnectWizard`)
 * e pelo modal "Como conectar uma IA" (`ConnectHelp`). Fonte da verdade em texto:
 * docs/05-conectar-clientes.md — mudou lá, muda aqui.
 *
 * A UI nunca conhece o `MCP_TOKEN` (o servidor só diz `mcpAuth: "token"`): os
 * snippets usam o marcador `<MCP_TOKEN>` e dizem onde está o valor.
 */
import type { Color, GameState, ServerInfo } from "@shared/types";
import { COLOR_LABEL } from "./status";

export type Client = "code" | "desktop" | "web" | "codex" | "other";

export const CLIENTS: { id: Client; label: string }[] = [
  { id: "code", label: "Claude Code" },
  { id: "desktop", label: "Claude Desktop" },
  { id: "web", label: "Claude.ai / ChatGPT" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Outro" },
];

export const TOKEN_PLACEHOLDER = "<MCP_TOKEN>";

export interface ConnectContext {
  mcpUrl: string;
  token: boolean;
  docker: boolean;
  /** A URL anunciada já é pública (https, fora do localhost). */
  publicUrl: boolean;
}

export function connectContext(server: ServerInfo | null): ConnectContext {
  const mcpUrl = server?.mcpUrl ?? "http://localhost:3939/mcp";
  let publicUrl = false;
  try {
    const url = new URL(mcpUrl);
    publicUrl = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
  } catch {
    /* URL estranha: trata como local */
  }
  return { mcpUrl, token: server?.mcpAuth === "token", docker: server?.runtime === "docker", publicUrl };
}

/** Base (sem `/mcp`) da URL do servidor, para o comando do túnel. */
function serverBase(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, "");
}

export function claudeCodeSnippet(ctx: ConnectContext): string {
  const header = ctx.token ? ` --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"` : "";
  return `claude mcp add -s user --transport http xadrez ${ctx.mcpUrl}${header}`;
}

/**
 * Claude Desktop via ponte stdio `mcp-remote`. O header vai por variável de
 * ambiente porque o Claude Desktop no Windows quebra argumentos com espaço
 * (recomendação do próprio README do mcp-remote).
 */
export function claudeDesktopSnippet(ctx: ConnectContext): string {
  const args = ["-y", "mcp-remote", ctx.mcpUrl];
  if (ctx.mcpUrl.startsWith("http:")) args.push("--allow-http");
  const entry: Record<string, unknown> = { command: "npx", args };
  if (ctx.token) {
    args.push("--header", "Authorization:${AUTH_HEADER}");
    entry.env = { AUTH_HEADER: `Bearer ${TOKEN_PLACEHOLDER}` };
  }
  return JSON.stringify({ mcpServers: { xadrez: entry } }, null, 2);
}

export function mcpRemoteSnippet(ctx: ConnectContext): string {
  const allow = ctx.mcpUrl.startsWith("http:") ? " --allow-http" : "";
  const header = ctx.token ? ` --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"` : "";
  return `npx -y mcp-remote ${ctx.mcpUrl}${allow}${header}`;
}

export function codexSnippet(ctx: ConnectContext): string {
  const lines = [
    "# ~/.codex/config.toml",
    "[mcp_servers.xadrez]",
    `url = "${ctx.mcpUrl}"`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 180",
  ];
  if (ctx.token) lines.push(`http_headers = { Authorization = "Bearer ${TOKEN_PLACEHOLDER}" }`);
  return lines.join("\n");
}

export function cursorSnippet(ctx: ConnectContext): string {
  const entry: Record<string, unknown> = { url: ctx.mcpUrl };
  if (ctx.token) entry.headers = { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` };
  return JSON.stringify({ mcpServers: { xadrez: entry } }, null, 2);
}

/** URL para conectores que não mandam header (Claude.ai, ChatGPT): token na query. */
export function publicConnectorUrl(ctx: ConnectContext): string {
  const base = ctx.publicUrl ? ctx.mcpUrl : "https://<seu-tunel>.trycloudflare.com/mcp";
  return `${base}?token=${TOKEN_PLACEHOLDER}`;
}

/** Passos de túnel + `.env` para Claude.ai / ChatGPT, que chamam da nuvem. */
export function tunnelSnippet(ctx: ConnectContext): string {
  /* Com PUBLIC_URL já público não dá para saber a porta local: assume a padrão. */
  const local = ctx.publicUrl ? "http://localhost:3939" : serverBase(ctx.mcpUrl);
  const restart = ctx.docker ? "docker compose up -d" : "npm start   # reinicie o servidor";
  return [
    "# 1) túnel HTTPS público até o servidor (deixe esta janela aberta)",
    `npx cloudflared tunnel --url ${local}`,
    "",
    "# 2) no .env do servidor (troque pela URL que o cloudflared mostrou)",
    "MCP_TOKEN=uma-senha-longa-e-aleatoria",
    "PUBLIC_URL=https://<seu-tunel>.trycloudflare.com",
    "ALLOWED_HOSTS=.trycloudflare.com",
    "",
    "# 3) aplique",
    restart,
  ].join("\n");
}

export interface ClientSnippet {
  code: string;
  note: string;
}

/** Snippet principal de cada cliente, para o onboarding. */
export function snippetFor(client: Client, ctx: ConnectContext): ClientSnippet {
  /* O aviso do token (onde está o valor) é mostrado à parte por quem usa o snippet. */
  const tokenNote = "";
  switch (client) {
    case "desktop":
      return {
        code: claudeDesktopSnippet(ctx),
        note: `Cole em claude_desktop_config.json (Settings → Developer → Edit Config) e reinicie o app.${tokenNote}`,
      };
    case "web":
      return {
        code: publicConnectorUrl(ctx),
        note: ctx.publicUrl
          ? "Claude.ai e ChatGPT chamam o servidor a partir da nuvem: use esta URL pública no conector (autenticação: nenhuma). O token vai na própria URL."
          : "Claude.ai e ChatGPT chamam o servidor a partir da nuvem, então localhost não serve: é preciso um túnel HTTPS e um token. Veja os passos em “Ver todas as opções de cliente”.",
      };
    case "codex":
      return {
        code: codexSnippet(ctx),
        note: `Salve e rode codex mcp list (xadrez deve aparecer como enabled).${tokenNote}`,
      };
    case "other":
      return {
        code: mcpRemoteSnippet(ctx),
        note: `Clientes com MCP por HTTP (Jan, Cursor, Windsurf…) aceitam a URL direto; os só-stdio usam esta ponte.${tokenNote}`,
      };
    case "code":
    default:
      return {
        code: claudeCodeSnippet(ctx),
        note: `Cole no terminal, em qualquer pasta (-s user vale para todas), e abra o claude.${tokenNote}`,
      };
  }
}

/** Sessões que contam como "cliente conectado": as inativas estão para expirar. */
export function activeSessions(server: ServerInfo | null): ServerInfo["mcpSessions"] {
  return (server?.mcpSessions ?? []).filter((s) => s.active !== false);
}

/**
 * Frase para o chat. Se um assento está esperando uma sessão MCP, a IA deve
 * entrar nele (`join_game`) — e não criar outra partida por cima.
 */
export function chatPrompt(state: GameState | null): string {
  if (!state || state.status === "finished") return "vamos jogar xadrez, eu de brancas, me ensine";
  const empty = (["white", "black"] as Color[]).filter((c) => state.seats[c].kind === "empty");
  if (empty.length === 1) {
    const color = empty[0];
    const other = color === "white" ? "black" : "white";
    const withHuman = state.seats[other].kind === "human";
    return `entre na partida de xadrez que está esperando (join_game) e jogue de ${COLOR_LABEL[color]}${
      withHuman ? "; me ensine enquanto jogamos" : ""
    }`;
  }
  return "vamos jogar xadrez, eu de brancas, me ensine";
}
