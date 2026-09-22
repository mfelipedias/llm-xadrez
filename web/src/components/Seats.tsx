import { useEffect, useState } from "react";
import type { Color, GameState, Seat, ServerInfo } from "@shared/types";
import { CopyButton } from "./CopyButton";

interface SeatsProps {
  state: GameState;
  server: ServerInfo | null;
  onOpenHelp: () => void;
}

const COLOR_LABEL: Record<Color, string> = { white: "Brancas", black: "Pretas" };
const THINKING_WINDOW_MS = 3000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function mcpStatus(seat: Seat, server: ServerInfo | null, now: number): { text: string; tone: string } {
  const session =
    server && seat.sessionId !== undefined ? server.mcpSessions.find((s) => s.sessionId === seat.sessionId) : undefined;
  if (server && !session) return { text: "sem conexão", tone: "bad" };
  if (session?.waiting) return { text: "aguardando", tone: "ok" };
  const lastSeen = session?.lastSeenAt ?? seat.lastSeenAt;
  if (lastSeen && now - Date.parse(lastSeen) < THINKING_WINDOW_MS) {
    return { text: "pensando…", tone: "busy" };
  }
  return session?.waiting === false ? { text: "ociosa", tone: "idle" } : { text: "aguardando", tone: "ok" };
}

function SeatCard({
  color,
  seat,
  state,
  server,
  now,
  onOpenHelp,
}: {
  color: Color;
  seat: Seat;
  state: GameState;
  server: ServerInfo | null;
  now: number;
  onOpenHelp: () => void;
}) {
  const isTurn = state.status === "active" && state.turn === color;
  const icon = seat.kind === "human" ? "👤" : seat.kind === "mcp" ? "🤖" : "⬚";
  const kindLabel = seat.kind === "human" ? "humano" : seat.kind === "mcp" ? "LLM via MCP" : "vazio";

  return (
    <div className={`seat seat-${color}${isTurn ? " seat-turn" : ""} seat-kind-${seat.kind}`}>
      <div className="seat-head">
        <span className="seat-color" aria-hidden="true">
          {color === "white" ? "○" : "●"}
        </span>
        <span className="seat-color-label">{COLOR_LABEL[color]}</span>
        {isTurn && <span className="seat-turn-badge">vez</span>}
      </div>
      {seat.kind === "empty" ? (
        <div className="seat-empty">
          <div className="seat-name">
            <span aria-hidden="true">{icon}</span> Aguardando IA — conecte via MCP
          </div>
          {server && (
            <div className="seat-mcp-url">
              <code>{server.mcpUrl}</code>
              <CopyButton text={server.mcpUrl} />
            </div>
          )}
          <button type="button" className="link" onClick={onOpenHelp}>
            como conectar?
          </button>
        </div>
      ) : (
        <div className="seat-body">
          <div className="seat-name">
            <span aria-hidden="true">{icon}</span> {seat.name}
            <span className="seat-kind"> · {kindLabel}</span>
          </div>
          {seat.kind === "mcp" && (
            <SeatActivity seat={seat} server={server} now={now} />
          )}
        </div>
      )}
    </div>
  );
}

function SeatActivity({ seat, server, now }: { seat: Seat; server: ServerInfo | null; now: number }) {
  const status = mcpStatus(seat, server, now);
  return (
    <div className={`seat-status seat-status-${status.tone}`}>
      <span className="dot" aria-hidden="true" />
      {status.text}
    </div>
  );
}

export function Seats({ state, server, onOpenHelp }: SeatsProps) {
  const now = useNow(1000);
  return (
    <section className="seats" aria-label="Jogadores">
      <SeatCard color="white" seat={state.seats.white} state={state} server={server} now={now} onOpenHelp={onOpenHelp} />
      <SeatCard color="black" seat={state.seats.black} state={state} server={server} now={now} onOpenHelp={onOpenHelp} />
    </section>
  );
}
