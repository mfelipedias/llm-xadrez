import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Color, GameStatus, MessageRequest, NewGameRequest, PieceType } from "@shared/types";
import { api, ApiError, useGameSocket } from "./api";
import { playSound, useSoundPreference } from "./sound";
import { Board } from "./components/Board";
import { Seats } from "./components/Seats";
import { LessonFeed } from "./components/LessonFeed";
import { MoveList } from "./components/MoveList";
import { MessageBox } from "./components/MessageBox";
import { Controls } from "./components/Controls";
import { NewGameDialog } from "./components/NewGameDialog";
import { StatusBar } from "./components/StatusBar";
import { ConnectHelp } from "./components/ConnectHelp";

interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
}

const APP_TITLE = "LLM Xadrez";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.legalMoves && err.legalMoves.length > 0) {
      const shown = err.legalMoves.slice(0, 12).join(" ");
      const more = err.legalMoves.length > 12 ? " …" : "";
      return `${err.message} Lances legais: ${shown}${more}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Erro inesperado";
}

function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

const PIECE_GLYPH: Record<PieceType, Record<"w" | "b", string>> = {
  p: { w: "♙", b: "♟" },
  n: { w: "♘", b: "♞" },
  b: { w: "♗", b: "♝" },
  r: { w: "♖", b: "♜" },
  q: { w: "♕", b: "♛" },
  k: { w: "♔", b: "♚" },
};

export function App() {
  const { state, server, connected, mock } = useGameSocket();
  const [soundOn, toggleSound] = useSoundPreference();

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [previewPly, setPreviewPlyRaw] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [showNewGame, setShowNewGame] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [boardResetKey, setBoardResetKey] = useState(0);

  const notify = useCallback((text: string, kind: Toast["kind"] = "error") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === "error" ? 6000 : 2500);
  }, []);

  /* ---------- reset ao trocar de partida ---------- */
  const gameId = state?.id;
  useEffect(() => {
    setPreviewPlyRaw(null);
    setFlipped(false);
  }, [gameId]);

  /* ---------- preview do histórico ---------- */
  const livePly = state?.ply ?? 0;
  const setPreviewPly = useCallback(
    (ply: number | null) => {
      if (ply === null || ply >= livePly) {
        setPreviewPlyRaw(null);
      } else {
        setPreviewPlyRaw(Math.max(0, ply));
      }
    },
    [livePly],
  );

  useEffect(() => {
    if (previewPly !== null && previewPly >= livePly) setPreviewPlyRaw(null);
  }, [previewPly, livePly]);

  const previewMove = useMemo(() => {
    if (!state || previewPly === null || previewPly === 0) return null;
    return state.history.find((m) => m.ply === previewPly) ?? null;
  }, [state, previewPly]);

  const displayedFen = state
    ? previewPly === null
      ? state.fen
      : previewPly === 0
        ? state.startFen
        : (previewMove?.fenAfter ?? state.fen)
    : "";

  /* ---------- orientação ---------- */
  const humanColors = useMemo(
    () => (state ? (["white", "black"] as Color[]).filter((c) => state.seats[c].kind === "human") : []),
    [state],
  );
  const baseOrientation: Color = humanColors.length === 1 ? humanColors[0] : "white";
  const orientation: Color = flipped ? opposite(baseOrientation) : baseOrientation;

  /* ---------- título da aba ---------- */
  const isHumanTurn = !!state && state.status === "active" && state.seats[state.turn].kind === "human";
  useEffect(() => {
    document.title = isHumanTurn ? `♟ Sua vez — ${APP_TITLE}` : APP_TITLE;
  }, [isHumanTurn]);

  /* ---------- sons ---------- */
  const prevRef = useRef<{ id: string; ply: number; status: GameStatus } | null>(null);
  useEffect(() => {
    if (!state) return;
    const prev = prevRef.current;
    prevRef.current = { id: state.id, ply: state.ply, status: state.status };
    if (!prev || prev.id !== state.id) return;
    if (state.ply > prev.ply && state.lastMove) {
      playSound(state.lastMove.isCheck ? "check" : state.lastMove.captured ? "capture" : "move");
    }
    if (state.status === "finished" && prev.status !== "finished") {
      playSound("end");
    }
  }, [state]);

  /* ---------- teclado: ← → Home End ---------- */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!state || showNewGame || showHelp) return;
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      const current = previewPly ?? state.ply;
      switch (ev.key) {
        case "ArrowLeft":
          ev.preventDefault();
          setPreviewPly(current - 1);
          break;
        case "ArrowRight":
          ev.preventDefault();
          setPreviewPly(current + 1);
          break;
        case "Home":
          ev.preventDefault();
          setPreviewPly(0);
          break;
        case "End":
          ev.preventDefault();
          setPreviewPly(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, previewPly, showNewGame, showHelp, setPreviewPly]);

  /* ---------- ações ---------- */
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (err) {
        notify(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  const handleMove = useCallback(
    async (uci: string) => {
      try {
        await api.move(uci);
      } catch (err) {
        notify(errorMessage(err));
        setBoardResetKey((k) => k + 1);
      }
    },
    [notify],
  );

  const handleNewGame = useCallback(async (req: NewGameRequest) => {
    await api.newGame(req);
  }, []);

  const handleMessage = useCallback(async (req: MessageRequest) => {
    await api.message(req);
  }, []);

  const copyFen = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayedFen);
      notify("FEN copiado", "info");
    } catch {
      notify("Não foi possível copiar o FEN");
    }
  }, [displayedFen, notify]);

  /* ---------- render ---------- */
  const connectionLabel = mock ? "modo demonstração" : connected ? "conectado" : "reconectando…";
  const connectionTone = mock ? "mock" : connected ? "on" : "off";

  const header = (
    <header className="app-header">
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">♞</span>
        <h1>{APP_TITLE}</h1>
        {server && <span className="brand-version">v{server.version}</span>}
      </div>
      <div className="header-actions">
        <span className={`conn conn-${connectionTone}`} title={mock ? "Fixture local (?mock=1): sem WebSocket" : undefined}>
          <span className="dot" aria-hidden="true" />
          {connectionLabel}
        </span>
        <button type="button" className="btn btn-small" onClick={() => setShowHelp(true)} disabled={!server}>
          Conectar IA
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={toggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? "Desligar sons" : "Ligar sons"}
          title={soundOn ? "Sons ligados" : "Sons desligados"}
        >
          {soundOn ? "🔊" : "🔇"}
        </button>
      </div>
    </header>
  );

  if (!state) {
    return (
      <div className="app">
        {header}
        <main className="loading">
          <div className="loading-card">
            <div className="spinner" aria-hidden="true" />
            <p>{connected ? "Carregando a partida…" : "Conectando ao servidor…"}</p>
            <p className="muted">
              O servidor deve estar no ar em <code>localhost:3939</code> (<code>npm run dev</code>). Para ver a interface sem
              servidor, abra <code>?mock=1</code>.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const interactive =
    state.status === "active" && state.seats[state.turn].kind === "human" && previewPly === null && (connected || mock);
  const highlight = previewPly === null ? state.highlight : null;

  const capturedRow = (
    <div className="captured" aria-label="Peças capturadas">
      <span>
        <span className="captured-label">brancas tomaram</span>{" "}
        <span className="captured-pieces">{state.captured.byWhite.map((p, i) => <span key={i}>{PIECE_GLYPH[p].b}</span>)}</span>
        {state.materialBalance > 0 && <span className="captured-balance">+{state.materialBalance}</span>}
      </span>
      <span>
        <span className="captured-label">pretas tomaram</span>{" "}
        <span className="captured-pieces">{state.captured.byBlack.map((p, i) => <span key={i}>{PIECE_GLYPH[p].w}</span>)}</span>
        {state.materialBalance < 0 && <span className="captured-balance">+{-state.materialBalance}</span>}
      </span>
    </div>
  );

  return (
    <div className="app">
      {header}
      <main className="layout">
        <section className="col-board">
          <Seats state={state} server={server} onOpenHelp={() => setShowHelp(true)} />

          {previewPly !== null && (
            <div className="preview-banner" role="status">
              <span>
                {previewPly === 0
                  ? "Visualizando a posição inicial"
                  : `Visualizando lance ${previewPly}${previewMove ? ` (${previewMove.color === "white" ? `${previewMove.moveNumber}.` : `${previewMove.moveNumber}…`} ${previewMove.san})` : ""}`}
              </span>
              <button type="button" className="btn btn-small btn-primary" onClick={() => setPreviewPly(null)}>
                voltar ao vivo
              </button>
            </div>
          )}

          <Board
            state={state}
            fen={displayedFen}
            previewMove={previewMove}
            isPreview={previewPly !== null}
            interactive={interactive}
            orientation={orientation}
            highlight={highlight}
            onMove={handleMove}
            resetKey={boardResetKey}
          />

          <Controls
            state={state}
            group="board"
            pgnUrl={api.pgnUrl}
            busy={busy}
            onFlip={() => setFlipped((f) => !f)}
            onCopyFen={() => void copyFen()}
            onTakeback={() => void run(() => api.takeback())}
            onClearHighlight={() => void run(() => api.clearHighlight())}
            onNewGame={() => setShowNewGame(true)}
            onResign={(color) => void run(() => api.resign(color))}
            onDraw={(color) => void run(() => api.draw(color))}
          />

          <StatusBar state={state} />
          {capturedRow}
        </section>

        <aside className="col-side">
          <LessonFeed state={state} selectedPly={previewPly} onSelectPly={setPreviewPly} />
          <MoveList history={state.history} selectedPly={previewPly} onSelect={setPreviewPly} />
          <MessageBox state={state} onSend={handleMessage} />
          <Controls
            state={state}
            group="game"
            pgnUrl={api.pgnUrl}
            busy={busy}
            onFlip={() => setFlipped((f) => !f)}
            onCopyFen={() => void copyFen()}
            onTakeback={() => void run(() => api.takeback())}
            onClearHighlight={() => void run(() => api.clearHighlight())}
            onNewGame={() => setShowNewGame(true)}
            onResign={(color) => void run(() => api.resign(color))}
            onDraw={(color) => void run(() => api.draw(color))}
          />
        </aside>
      </main>

      <div className="toasts" aria-live="assertive">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>

      {showNewGame && <NewGameDialog onClose={() => setShowNewGame(false)} onSubmit={handleNewGame} />}
      {showHelp && server && <ConnectHelp mcpUrl={server.mcpUrl} onClose={() => setShowHelp(false)} />}
    </div>
  );
}
