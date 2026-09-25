/**
 * Camada de rede do navegador: WebSocket (/ws) para o estado em tempo real e
 * chamadas REST (/api/*) tipadas pelo contrato em shared/types.ts.
 *
 * Com `?mock=1` na URL, usa o fixture de web/src/dev/fixtures.ts, não abre
 * WebSocket e as chamadas REST apenas registram no console.
 */
import { useEffect, useState } from "react";
import type {
  ApiError as ApiErrorBody,
  Color,
  GameState,
  MessageRequest,
  ModelInfo,
  MoveRequest,
  NewGameRequest,
  ProvidersResponse,
  ProviderTestResponse,
  ProviderUpsert,
  ResignRequest,
  ServerInfo,
  TakebackRequest,
  ThinkingMode,
  WsServerMessage,
} from "@shared/types";
import { MockHttpError, mockFixture, mockRequest } from "./dev/fixtures";

/**
 * `?mock=1` usa o cenário padrão; `?mock=waiting|llmvsllm|finished|empty|bots|botsvsbots`
 * escolhe um dos cenários de `dev/fixtures.ts` (docs/10 §7, docs/09 §4.3).
 */
const mockParam: string | null = new URLSearchParams(window.location.search).get("mock");
export const isMock: boolean = mockParam !== null && mockParam !== "" && mockParam !== "0";
const fixture = isMock ? mockFixture(mockParam === "1" ? "default" : (mockParam as string)) : null;

/** Erro de API com status HTTP e, em lance ilegal, a lista de lances legais. */
export class ApiError extends Error {
  readonly status: number;
  readonly legalMoves?: string[];
  /** "admin_forbidden": rota de administração recusada (403). */
  readonly code?: string;
  /** Com `code: "admin_forbidden"`: o servidor aceitaria um token de administração. */
  readonly adminTokenAccepted?: boolean;
  /** Dica acionável que alguns erros trazem (ex.: teste de provedor, 502). */
  readonly hint?: string;

  constructor(
    status: number,
    message: string,
    legalMoves?: string[],
    extra: { code?: string; adminTokenAccepted?: boolean; hint?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.legalMoves = legalMoves;
    this.code = extra.code;
    this.adminTokenAccepted = extra.adminTokenAccepted;
    this.hint = extra.hint;
  }

  get adminForbidden(): boolean {
    return this.status === 403 && this.code === "admin_forbidden";
  }
}

/* ---------------------- token de administração ---------------------- */

/**
 * Token para as rotas que gravam `providers.json` quando o navegador não está no
 * mesmo computador do servidor (docs/05 → "Tela Provedores de outro computador").
 * Fica em `sessionStorage` — some ao fechar a aba — e nunca vai para `localStorage`.
 */
const ADMIN_TOKEN_KEY = "xadrez.adminToken";

export function getAdminToken(): string | null {
  try {
    const value = window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
    return value ? value : null;
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* sessionStorage bloqueado: o token vale só para esta chamada */
  }
}

function adminHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isApiErrorBody(value: unknown): value is Partial<ApiErrorBody> & { hint?: unknown } {
  return typeof value === "object" && value !== null;
}

function toApiError(status: number, body: unknown): ApiError {
  const parsed = isApiErrorBody(body) ? body : {};
  const message =
    typeof parsed.error === "string"
      ? parsed.error
      : typeof body === "string" && body
        ? body
        : `Erro ${status}`;
  return new ApiError(status, message, parsed.legalMoves, {
    code: typeof parsed.code === "string" ? parsed.code : undefined,
    adminTokenAccepted: typeof parsed.adminTokenAccepted === "boolean" ? parsed.adminTokenAccepted : undefined,
    hint: typeof parsed.hint === "string" ? parsed.hint : undefined,
  });
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  if (isMock) {
    const method = init?.method ?? "GET";
    console.info(`[mock] ${method} ${path}`, init?.body ?? "");
    // Os cenários de fixture respondem às rotas de provedores (inclusive gravação,
    // só em memória) para que a tela "Provedores" possa ser vista sem servidor.
    try {
      const headers = new Headers(init?.headers);
      return mockRequest(path, method, typeof init?.body === "string" ? init.body : undefined, headers.get("Authorization"));
    } catch (err) {
      if (err instanceof MockHttpError) throw toApiError(err.status, err.body);
      throw err;
    }
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Sem conexão com o servidor (${reason})`);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw toApiError(response.status, body);
  return body;
}

function send(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload ?? {}),
  });
}

function post(path: string, payload: unknown): Promise<unknown> {
  return send("POST", path, payload);
}

/** Corpo de `/api/bots/:color/{sit,resume}`: um `SeatRequest` de bot sem o `kind`. */
export interface BotSeatBody {
  profileId?: string;
  providerId?: string;
  model?: string;
  name?: string;
  thinking?: ThinkingMode;
}

export type { ProvidersResponse, ProviderTestResponse, ProviderUpsert };

export const api = {
  /** Lance pelo assento humano da vez. `move` em UCI (ex.: "e7e8q") ou SAN. */
  async move(move: string): Promise<void> {
    const body: MoveRequest = { move };
    await post("/api/move", body);
  },
  async newGame(req: NewGameRequest): Promise<void> {
    await post("/api/game", req);
  },
  async message(req: MessageRequest): Promise<void> {
    await post("/api/message", req);
  },
  async takeback(plies?: number): Promise<void> {
    const body: TakebackRequest = plies === undefined ? {} : { plies };
    await post("/api/takeback", body);
  },
  async resign(color?: Color): Promise<void> {
    const body: ResignRequest = color ? { color } : {};
    await post("/api/resign", body);
  },
  async draw(color?: Color): Promise<void> {
    await post("/api/draw", color ? { color } : {});
  },
  async clearHighlight(): Promise<void> {
    await post("/api/highlight/clear", {});
  },

  /**
   * Bots internos do servidor (docs/09 §5.3). Todas devolvem o `GameState`
   * novo, mas a UI ignora: o WebSocket entrega o mesmo estado logo em seguida.
   */
  bots: {
    async sit(color: Color, body: BotSeatBody): Promise<void> {
      await post(`/api/bots/${color}/sit`, body);
    },
    async stop(color: Color): Promise<void> {
      await post(`/api/bots/${color}/stop`, {});
    },
    /** Sem corpo retoma o mesmo modelo; com `profileId`/`model` troca de modelo. */
    async resume(color: Color, body: BotSeatBody = {}): Promise<void> {
      await post(`/api/bots/${color}/resume`, body);
    },
    async leave(color: Color): Promise<void> {
      await post(`/api/bots/${color}/leave`, {});
    },
  },

  /**
   * Provedores de LLM (docs/09 §5.3). Nenhuma destas chamadas envia ou recebe
   * chave de API: o servidor devolve só `hasApiKey`/`apiKeyMasked`.
   */
  providers: {
    /** Manda o token de administração, se houver, para o servidor calcular `canAdmin`. */
    async list(): Promise<ProvidersResponse> {
      const body = (await request("/api/providers", { headers: adminHeaders() })) as ProvidersResponse | null;
      return body ?? { providers: [], profiles: [], presets: [] };
    },
    /**
     * Teste de conexão. Falha do provedor (502) vira `{ ok: false, error, hint? }`;
     * recusa de administração (403) e falta de servidor continuam lançando `ApiError`.
     */
    async test(id: string): Promise<ProviderTestResponse> {
      try {
        const body = (await send("POST", `/api/providers/${encodeURIComponent(id)}/test`, {}, adminHeaders())) as
          | ProviderTestResponse
          | null;
        return body ?? { ok: true, latencyMs: 0 };
      } catch (err) {
        if (err instanceof ApiError && !err.adminForbidden && err.status !== 0) {
          return err.hint ? { ok: false, error: err.message, hint: err.hint } : { ok: false, error: err.message };
        }
        throw err;
      }
    },
    async models(id: string, refresh = false): Promise<ModelInfo[]> {
      const query = refresh ? "?refresh=1" : "";
      const body = (await request(`/api/providers/${encodeURIComponent(id)}/models${query}`, {
        headers: adminHeaders(),
      })) as ModelInfo[] | null;
      return body ?? [];
    },
    /**
     * Cria ou atualiza (`PUT` é upsert). Só campos sem segredo: `null` limpa
     * `baseUrl`/`apiKeyEnv`/`timeoutMs`. Nunca `apiKey` — o servidor recusa.
     */
    async save(id: string, patch: ProviderUpsert): Promise<void> {
      await send("PUT", `/api/providers/${encodeURIComponent(id)}`, patch, adminHeaders());
    },
    /** Sem `id`, o servidor escolhe um livre (sufixo `-2`, `-3`…) em vez de devolver 409. */
    async addPreset(preset: string, id?: string): Promise<string | null> {
      const body = await send("POST", "/api/providers/preset", id ? { preset, id } : { preset }, adminHeaders());
      if (typeof body === "object" && body !== null && "id" in body && typeof body.id === "string") return body.id;
      return null;
    },
    async remove(id: string): Promise<void> {
      await send("DELETE", `/api/providers/${encodeURIComponent(id)}`, undefined, adminHeaders());
    },
  },

  pgnUrl: "/api/pgn",
};

export interface GameConnection {
  state: GameState | null;
  server: ServerInfo | null;
  connected: boolean;
  mock: boolean;
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

/**
 * Abre o WebSocket, mantém o último estado recebido (fonte única de verdade)
 * e reconecta com backoff exponencial (1 s → 10 s).
 */
export function useGameSocket(): GameConnection {
  const [state, setState] = useState<GameState | null>(fixture?.state ?? null);
  const [server, setServer] = useState<ServerInfo | null>(fixture?.server ?? null);
  const [connected, setConnected] = useState<boolean>(isMock);

  useEffect(() => {
    if (isMock) return;

    let socket: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let timer: number | undefined;

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(10_000, 1000 * 2 ** attempt);
      attempt += 1;
      window.clearTimeout(timer);
      timer = window.setTimeout(connect, delay);
    };

    const handleMessage = (raw: string) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(raw) as WsServerMessage;
      } catch {
        console.warn("[ws] mensagem inválida", raw);
        return;
      }
      switch (msg.type) {
        case "hello":
          setState(msg.state);
          setServer(msg.server);
          break;
        case "state":
          setState(msg.state);
          break;
        case "server":
          setServer(msg.server);
          break;
        case "bot":
          /*
           * Status/uso de um bot sem o estado inteiro (docs/09 §5.4): o patch
           * entra no assento e no `server.bots` para a UI não piscar.
           */
          setState((current) =>
            current && current.seats[msg.color].kind === "bot"
              ? {
                  ...current,
                  seats: { ...current.seats, [msg.color]: { ...current.seats[msg.color], bot: msg.bot } },
                }
              : current,
          );
          setServer((current) =>
            current
              ? { ...current, bots: { white: null, black: null, ...(current.bots ?? {}), [msg.color]: msg.bot } }
              : current,
          );
          break;
        default:
          console.warn("[ws] tipo desconhecido", msg);
      }
    };

    const connect = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(wsUrl());
      } catch (err) {
        console.warn("[ws] falha ao abrir", err);
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (ev) => handleMessage(String(ev.data));
      socket.onerror = () => {
        socket?.close();
      };
      socket.onclose = () => {
        setConnected(false);
        socket = null;
        scheduleReconnect();
      };
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !socket) {
        attempt = 0;
        window.clearTimeout(timer);
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return { state, server, connected, mock: isMock };
}
