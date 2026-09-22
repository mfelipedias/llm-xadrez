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
  MoveRequest,
  NewGameRequest,
  ResignRequest,
  ServerInfo,
  TakebackRequest,
  WsServerMessage,
} from "@shared/types";
import { mockServer, mockState } from "./dev/fixtures";

export const isMock: boolean =
  new URLSearchParams(window.location.search).get("mock") === "1";

/** Erro de API com status HTTP e, em lance ilegal, a lista de lances legais. */
export class ApiError extends Error {
  readonly status: number;
  readonly legalMoves?: string[];

  constructor(status: number, message: string, legalMoves?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.legalMoves = legalMoves;
  }
}

function isApiErrorBody(value: unknown): value is Partial<ApiErrorBody> {
  return typeof value === "object" && value !== null;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  if (isMock) {
    console.info(`[mock] ${init?.method ?? "GET"} ${path}`, init?.body ?? "");
    return null;
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
  if (!response.ok) {
    const parsed = isApiErrorBody(body) ? body : {};
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof body === "string" && body
          ? body
          : `Erro ${response.status}`;
    throw new ApiError(response.status, message, parsed.legalMoves);
  }
  return body;
}

function post(path: string, payload: unknown): Promise<unknown> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

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
  const [state, setState] = useState<GameState | null>(isMock ? mockState : null);
  const [server, setServer] = useState<ServerInfo | null>(isMock ? mockServer : null);
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
