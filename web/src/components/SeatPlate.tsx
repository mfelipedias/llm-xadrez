/**
 * Placa de jogador (docs/10 §3.2): uma linha por assento, alinhada à largura do
 * tabuleiro — adversário em cima, você embaixo. Substitui `Seats`/`SeatCard` e
 * absorve o texto de vez/xeque que ficava no `StatusBar`.
 *
 * Duas coisas nasceram aqui na onda 3:
 * - assentos `bot` (docs/09 §4.3): provedor/modelo, status do loop, tokens e
 *   custo estimado, e um menu com parar / retomar / trocar modelo / liberar;
 * - modo espectador (docs/10 §3.5): a placa vira balão de professor, mostrando
 *   o último comentário daquela IA com a tinta da sua voz (`--ink`/`--ink-2`).
 */
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { Color, Commentary, GameState, PieceType, Seat, ServerInfo } from "@shared/types";
import { COLOR_TITLE, isAiSeat, seatKindLabel } from "../status";
import { BOT_STATUS_LABEL, BOT_STATUS_TONE, SLOW_THINKING_MS, elapsedText, isStoppedStatus, usageSpoken, usageText } from "../bots";
import { inkFor } from "../feed";
import { Markdown } from "../markdown";
import { Figurine, PIECE_WORD, figurineKey } from "./Figurine";

const THINKING_WINDOW_MS = 3000;

/** Relógio local para a janela de "pensando…" (a UI recalcula a cada segundo). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type Tone = "ok" | "busy" | "bad" | "idle";

const PLURAL: Record<string, string> = {
  rei: "reis",
  dama: "damas",
  torre: "torres",
  bispo: "bispos",
  cavalo: "cavalos",
  peão: "peões",
};

/** "2 peões, 1 cavalo" — resumo curto das capturas para leitor de tela. */
function capturedText(captured: PieceType[]): string {
  if (captured.length === 0) return "nenhuma";
  const counts = new Map<string, number>();
  for (const piece of captured) {
    const key = figurineKey(piece);
    const word = key ? PIECE_WORD[key] : piece;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, n]) => `${n} ${n > 1 ? PLURAL[word] ?? `${word}s` : word}`).join(", ");
}

/**
 * Estado de uma IA no assento. Tolera `SeatKind` desconhecido (ex.: "bot" do
 * plano 09): usa o status do próprio assento quando não há sessão MCP.
 */
function aiStatus(seat: Seat, server: ServerInfo | null, now: number): { text: string; tone: Tone } {
  const session =
    server && seat.sessionId !== undefined ? server.mcpSessions.find((s) => s.sessionId === seat.sessionId) : undefined;

  if (seat.kind === "mcp" && server && !session) return { text: "sem conexão", tone: "bad" };
  if (session?.waiting) return { text: "pronta, esperando a sua vez", tone: "ok" };

  const lastSeen = session?.lastSeenAt ?? seat.lastSeenAt;
  if (lastSeen && now - Date.parse(lastSeen) < THINKING_WINDOW_MS) {
    return { text: "pensando…", tone: "busy" };
  }
  if (session?.waiting === false) return { text: "parada", tone: "idle" };
  return { text: "pronta, esperando a sua vez", tone: "ok" };
}

/** "pensando há 14 s" e, passados 90 s, o aviso de lentidão (docs/10 §4). */
function thinkingText(sinceIso: string | undefined, now: number): string {
  const elapsed = elapsedText(sinceIso, now);
  if (!elapsed) return "pensando…";
  const started = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!Number.isNaN(started) && now - started > SLOW_THINKING_MS) {
    return `pensando há ${elapsed} — demorando, veja o chat`;
  }
  return `pensando há ${elapsed}`;
}

export type BotAction = "stop" | "resume" | "change" | "leave";

export interface SeatPlateProps {
  color: Color;
  state: GameState;
  server: ServerInfo | null;
  /** Peças que este lado capturou. */
  captured: PieceType[];
  /** Saldo de material em peões a favor deste lado (0 ou negativo = não mostra). */
  materialDelta: number;
  /** Abre a ajuda de conexão (assento livre). */
  onOpenHelp: () => void;
  /** Último comentário desta voz: vira balão no modo espectador (§3.5). */
  latestComment?: Commentary | null;
  /** Ações do bot; ausente = placa sem menu. */
  onBotAction?: (action: BotAction, color: Color) => void;
  busy?: boolean;
}

export function SeatPlate({
  color,
  state,
  server,
  captured,
  materialDelta,
  onOpenHelp,
  latestComment,
  onBotAction,
  busy,
}: SeatPlateProps) {
  const now = useNow(1000);
  const seat = state.seats[color];
  const bot = seat.kind === "bot" ? (seat.bot ?? null) : null;
  const isTurn = state.status === "active" && state.turn === color;
  const inCheck = isTurn && state.inCheck;

  let stateText: string;
  let tone: Tone = "idle";
  if (seat.kind === "empty") {
    stateText = "nenhuma IA conectada";
    tone = "bad";
  } else if (seat.kind === "human") {
    stateText = isTurn ? "sua vez" : seatKindLabel(seat.kind);
    tone = isTurn ? "ok" : "idle";
  } else if (bot) {
    tone = BOT_STATUS_TONE[bot.status];
    if (bot.status === "thinking") stateText = thinkingText(bot.thinkingSince, now);
    else if (isStoppedStatus(bot.status)) stateText = BOT_STATUS_LABEL[bot.status];
    else if (isTurn && bot.status === "acting") stateText = BOT_STATUS_LABEL.acting;
    else if (isTurn) stateText = thinkingText(bot.thinkingSince, now);
    else stateText = BOT_STATUS_LABEL[bot.status];
  } else {
    const status = aiStatus(seat, server, now);
    // MCP não tem `thinkingSince`: o relógio começa no lance do adversário.
    stateText = isTurn ? thinkingText(state.lastMove?.timestamp, now) : status.text;
    tone = isTurn ? "busy" : status.tone;
  }

  const name = seat.kind === "empty" ? "Assento livre" : seat.name || COLOR_TITLE[color];
  const enemy = color === "white" ? "b" : "w";

  return (
    <div
      className={`plate plate-${color}${isTurn ? " is-turn" : ""}${inCheck ? " is-check" : ""}${
        latestComment ? " has-bubble" : ""
      }`}
      data-kind={seat.kind}
    >
      <span className="plate-disc" aria-hidden="true">
        {color === "white" ? "○" : "●"}
      </span>
      <div className="plate-id">
        <h3 className="plate-name">{name}</h3>
        <p className="plate-meta">
          {isAiSeat(seat) && <span className={`dot tone-${tone}`} aria-hidden="true" />}
          <span className="plate-kind">{COLOR_TITLE[color]}</span>
          <span aria-hidden="true"> · </span>
          <span className={`plate-state tone-text-${tone}`}>{stateText}</span>
          {bot?.statusText && <span className="plate-statustext">{bot.statusText}</span>}
          {inCheck && <span className="plate-check">xeque!</span>}
        </p>
        {bot && (
          <p className="plate-bot">
            <span className="plate-model" title={`${bot.providerId} · ${bot.model}`}>
              {bot.providerId} · {bot.model}
            </span>
            <span className="plate-usage" aria-hidden="true">
              {usageText(bot.usage)}
            </span>
            <span className="sr-only">Consumo: {usageSpoken(bot.usage)}.</span>
          </p>
        )}
      </div>

      {seat.kind === "empty" ? (
        <button type="button" className="btn btn-small plate-connect" onClick={onOpenHelp}>
          Conectar IA
        </button>
      ) : (
        <p className="plate-captured">
          <span className="sr-only">Peças capturadas: {capturedText(captured)}.</span>
          <span className="plate-pieces" aria-hidden="true">
            {captured.map((piece, index) => {
              const key = figurineKey(piece);
              return key ? <Figurine key={index} piece={key} side={enemy} /> : null;
            })}
          </span>
          {materialDelta > 0 && (
            <span className="plate-delta" title="Saldo de material em peões">
              +{materialDelta}
            </span>
          )}
        </p>
      )}

      {bot && onBotAction && (
        <BotMenu color={color} stopped={isStoppedStatus(bot.status)} busy={!!busy} onAction={onBotAction} />
      )}

      {latestComment && <PlateBubble comment={latestComment} />}
    </div>
  );
}

/**
 * Balão de professor na placa (docs/10 §3.5): duas linhas por padrão,
 * expansível. O texto inteiro está sempre no DOM — o corte é visual — e o
 * botão só aparece quando há o que revelar.
 */
const BUBBLE_CLAMP = 110;

function PlateBubble({ comment }: { comment: Commentary }) {
  const [open, setOpen] = useState(false);
  const long = comment.text.length > BUBBLE_CLAMP;

  return (
    <div className={`plate-bubble ink-${inkFor(comment.author)}${open ? " is-open" : ""}`}>
      <Markdown text={comment.text} />
      {long && (
        <button
          type="button"
          className="link plate-bubble-more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "recolher" : "ver tudo"}
        </button>
      )}
    </div>
  );
}

/**
 * Menu "⋯" da placa, em `popover` nativo — o mesmo padrão do menu de
 * ferramentas do tablet e da confirmação de desistir (docs/10 §4, §6).
 */
function BotMenu({
  color,
  stopped,
  busy,
  onAction,
}: {
  color: Color;
  stopped: boolean;
  busy: boolean;
  onAction: (action: BotAction, color: Color) => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const id = `bot-menu-${color}`;
  const side = COLOR_TITLE[color].toLowerCase();

  const onToggle = (ev: SyntheticEvent<HTMLDivElement>) => {
    if ((ev as unknown as { newState?: string }).newState === "open") firstRef.current?.focus();
  };

  const run = (action: BotAction) => {
    popRef.current?.hidePopover?.();
    onAction(action, color);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-icon plate-menu-btn"
        data-color={color}
        popoverTarget={id}
        aria-label={`Ações do bot das ${side}`}
        disabled={busy}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <div id={id} ref={popRef} popover="auto" className="plate-menu" onToggle={onToggle}>
        <button
          type="button"
          className="btn btn-small plate-menu-item"
          ref={firstRef}
          onClick={() => run(stopped ? "resume" : "stop")}
        >
          {stopped ? "Retomar" : "Parar"}
        </button>
        <button type="button" className="btn btn-small plate-menu-item" onClick={() => run("change")}>
          Trocar de modelo
        </button>
        <button type="button" className="btn btn-small plate-menu-item" onClick={() => run("leave")}>
          Liberar assento
        </button>
      </div>
    </>
  );
}
