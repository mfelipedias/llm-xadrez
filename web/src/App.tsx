import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotStatus, Color, Commentary, GameStatus, MessageRequest, NewGameRequest } from "@shared/types";
import { api, ApiError, useGameSocket } from "./api";
import { playSound, useSoundPreference } from "./sound";
import { COLOR_LABEL, isAiSeat, opposite } from "./status";
import { useBoardPreset, useMediaQuery, useReducedMotion, useTheme } from "./theme";
import { setFavicon } from "./favicon";
import { Board } from "./components/Board";
import { BoardFrame } from "./components/BoardFrame";
import { BoardTools } from "./components/BoardTools";
import { ConnectWizard } from "./components/ConnectWizard";
import { GameActions } from "./components/GameActions";
import { GameBanner } from "./components/GameBanner";
import { LiveRegions } from "./components/LiveRegions";
import { MoveRibbon } from "./components/MoveRibbon";
import { NewGameDialog } from "./components/NewGameDialog";
import { Notebook } from "./components/Notebook";
import { SeatPlate, type BotAction } from "./components/SeatPlate";
import { ThemeToggle } from "./components/ThemeToggle";
import { Toaster, type ToastItem } from "./components/Toaster";
import { ConnectHelp } from "./components/ConnectHelp";
import { ProvidersDialog } from "./components/ProvidersDialog";
import { ChangeBotDialog } from "./components/ChangeBotDialog";
import type { BotChoice } from "./components/BotPicker";
import { Annotation } from "./components/Annotation";
import { inkFor } from "./feed";

const APP_TITLE = "LLM Xadrez";
const COLORS: Color[] = ["white", "black"];

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // Os lances legais não vão mais para o toast: o tabuleiro já mostra os
    // destinos (docs/10 §4). O que falta ao aluno é o verbo do que aconteceu.
    if (err.status === 0) return "Sem conexão com o servidor — confira se ele ainda está rodando.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Erro inesperado";
}

/** Estados terminais de um bot que merecem um aviso que não some sozinho. */
const BOT_ALERT: Partial<Record<BotStatus, string>> = {
  error: "parou com erro",
  budget_exceeded: "atingiu o limite de gasto da partida",
};

export function App() {
  const { state, server, connected, mock } = useGameSocket();
  const [soundOn, toggleSound] = useSoundPreference();
  const theme = useTheme();
  const board = useBoardPreset();
  const reducedMotion = useReducedMotion();
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [previewPly, setPreviewPlyRaw] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [showNewGame, setShowNewGame] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [changeBot, setChangeBot] = useState<Color | null>(null);
  const [busy, setBusy] = useState(false);
  /** Comentário que chegou com a aba em segundo plano (título + favicon, §4). */
  const [pendingComment, setPendingComment] = useState<string | null>(null);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback((text: string, kind: ToastItem["kind"] = "error", extra?: Partial<ToastItem>) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, kind, ...extra }]);
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

  /* Lances que chegaram durante a revisão: viram o chip "+N" na régua (§3.6). */
  const reviewStartPly = useRef<number | null>(null);
  if (previewPly === null) reviewStartPly.current = null;
  else if (reviewStartPly.current === null) reviewStartPly.current = livePly;
  const liveCount = previewPly === null ? 0 : Math.max(0, livePly - (reviewStartPly.current ?? livePly));

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
    () => (state ? COLORS.filter((c) => state.seats[c].kind === "human") : []),
    [state],
  );
  const baseOrientation: Color = humanColors.length === 1 ? humanColors[0] : "white";
  const orientation: Color = flipped ? opposite(baseOrientation) : baseOrientation;

  /* ---------- título da aba e favicon (§4) ---------- */
  const isHumanTurn = !!state && state.status === "active" && state.seats[state.turn].kind === "human";
  /** Um bot está pensando/agindo na vez dele: o ponto cinza do favicon (§4). */
  const isAiThinking =
    !!state &&
    state.status === "active" &&
    ["thinking", "acting"].includes(state.seats[state.turn].bot?.status ?? "");
  useEffect(() => {
    if (isHumanTurn) {
      document.title = `♟ Sua vez — ${APP_TITLE}`;
      setFavicon("turn");
    } else if (pendingComment) {
      document.title = `💬 ${pendingComment} — ${APP_TITLE}`;
      setFavicon("comment");
    } else {
      document.title = APP_TITLE;
      setFavicon(isAiThinking ? "thinking" : "idle");
    }
  }, [isHumanTurn, pendingComment, isAiThinking]);

  /** Voltar para a aba zera o aviso de comentário novo. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setPendingComment(null);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  /* ---------- sons, avisos de assento e de bot ---------- */
  const prevRef = useRef<{
    id: string;
    ply: number;
    status: GameStatus;
    ai: string;
    comment: string;
    bots: Record<Color, string>;
  } | null>(null);
  useEffect(() => {
    if (!state) return;
    const seatSignature = COLORS.map((c) => (isAiSeat(state.seats[c]) ? `${c}:${state.seats[c].name}` : "")).join("|");
    /*
     * A última fala pode vir do feed (`Commentary`) ou colada a um lance
     * (`make_move.comment`) — bots costumam usar o segundo caminho. O "tique" e
     * o título da aba (§4) reagem à mais recente das duas.
     */
    const lastComment = ((): { key: string; name: string; system: boolean } | null => {
      const comment = state.commentary[state.commentary.length - 1];
      const move = [...state.history].reverse().find((m) => m.comment);
      const commentAt = comment ? Date.parse(comment.timestamp) : -1;
      const moveAt = move ? Date.parse(move.timestamp) : -1;
      if (move && moveAt >= commentAt) {
        return { key: `m${move.ply}`, name: state.seats[move.color].name, system: false };
      }
      if (comment) {
        return { key: `c${comment.id}`, name: comment.authorName, system: comment.author === "system" };
      }
      return null;
    })();
    const botSignature = {
      white: state.seats.white.bot?.status ?? "",
      black: state.seats.black.bot?.status ?? "",
    } as Record<Color, string>;
    const prev = prevRef.current;
    prevRef.current = {
      id: state.id,
      ply: state.ply,
      status: state.status,
      ai: seatSignature,
      comment: lastComment?.key ?? "",
      bots: botSignature,
    };
    if (!prev || prev.id !== state.id) return;

    if (state.ply > prev.ply && state.lastMove) {
      playSound(state.lastMove.isCheck ? "check" : state.lastMove.captured ? "capture" : "move");
    }
    if (state.status === "finished" && prev.status !== "finished") {
      playSound("end");
    }
    // Comentário novo: "tique" e, se a aba está em segundo plano, marca o título.
    if (lastComment && lastComment.key !== prev.comment) {
      playSound("comment");
      if (document.visibilityState !== "visible" && !lastComment.system) {
        setPendingComment(lastComment.name || "Comentário");
      }
    }
    // Passo 4 do onboarding (§3.7): a IA sentou.
    if (seatSignature !== prev.ai) {
      for (const color of COLORS) {
        const seat = state.seats[color];
        const wasEmpty = !prev.ai.includes(`${color}:`);
        if (isAiSeat(seat) && wasEmpty) {
          playSound("join");
          notify(`${seat.name || "A IA"} entrou nas ${COLOR_LABEL[color]}`, "info");
        }
      }
    }
    // Bot que parou sozinho: aviso que fica até ser fechado, com "Retomar" (docs/09 §4.3).
    for (const color of COLORS) {
      const seat = state.seats[color];
      const status = seat.bot?.status;
      if (!status || status === prev.bots[color]) continue;
      const reason = BOT_ALERT[status];
      if (!reason) continue;
      const detail = seat.bot?.statusText ? ` — ${seat.bot.statusText}` : "";
      notify(`${seat.name || "O bot"} (${COLOR_LABEL[color]}) ${reason}${detail}`, "error", {
        timeout: 0,
        action: { label: "Retomar", onClick: () => void api.bots.resume(color).catch(() => undefined) },
      });
    }
  }, [state, notify]);

  /* ---------- teclado: ← → Home End (fora do tabuleiro) ---------- */
  const anyDialog = showNewGame || showHelp || showProviders || changeBot !== null;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!state || anyDialog) return;
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          // Dentro da grade do tabuleiro as setas movem a casa ativa (§6).
          target.closest('[role="grid"]') !== null ||
          target.closest('[role="tablist"]') !== null)
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
  }, [state, previewPly, anyDialog, setPreviewPly]);

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

  /** Rejeita de volta para o `Board`, que devolve a peça animada (§4). */
  const handleMove = useCallback(
    async (uci: string) => {
      try {
        await api.move(uci);
      } catch (err) {
        notify(errorMessage(err));
        throw err;
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

  /** Menu "⋯" da placa de um bot (docs/09 §5.3). */
  const handleBotAction = useCallback(
    (action: BotAction, color: Color) => {
      if (action === "change") {
        setChangeBot(color);
        return;
      }
      void run(async () => {
        if (action === "stop") await api.bots.stop(color);
        else if (action === "resume") await api.bots.resume(color);
        else await api.bots.leave(color);
      });
    },
    [run],
  );

  const handleChangeBot = useCallback(async (color: Color, choice: BotChoice) => {
    await api.bots.resume(color, choice);
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
  const hasProviderLayer = server?.providers !== undefined;

  /*
   * Header (§3.1): "Conectar IA" só enquanto falta alguém no tabuleiro; com os
   * dois assentos ocupados a ação vira informação ("1 IA conectada") e ainda
   * abre a ajuda, para quem quiser trocar de cliente.
   */
  const aiSeats = state ? COLORS.filter((c) => isAiSeat(state.seats[c])).length : 0;
  const freeSeats = state ? COLORS.filter((c) => state.seats[c].kind === "empty").length : 0;
  const connectLabel =
    freeSeats > 0 || aiSeats === 0 ? "Conectar IA" : aiSeats === 1 ? "1 IA conectada" : `${aiSeats} IAs conectadas`;

  const header = (
    <header className="app-header">
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">
          ♞
        </span>
        <h1>{APP_TITLE}</h1>
        {server && <span className="brand-version">v{server.version}</span>}
      </div>
      <div className="header-actions">
        <span
          className={`conn conn-${connectionTone}`}
          title={mock ? "Fixture local (?mock=…): sem WebSocket" : undefined}
        >
          <span className="dot" aria-hidden="true" />
          <span className="conn-label">{connectionLabel}</span>
          <span className="sr-only">Servidor: {connectionLabel}</span>
        </span>
        <button
          type="button"
          className={`btn btn-small btn-connect${freeSeats > 0 || aiSeats === 0 ? "" : " btn-connect-info"}`}
          onClick={() => setShowHelp(true)}
          disabled={!server}
          title="Como conectar uma IA por MCP"
        >
          {connectLabel}
        </button>
        {hasProviderLayer && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setShowProviders(true)}
            title="Provedores de LLM para os bots do servidor"
          >
            Provedores
          </button>
        )}
        <ThemeToggle mode={theme.mode} onCycle={theme.cycle} />
        <button
          type="button"
          className="btn btn-icon"
          onClick={toggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? "Desligar sons" : "Ligar sons"}
          title={soundOn ? "Sons ligados" : "Sons desligados"}
        >
          <span aria-hidden="true">{soundOn ? "🔊" : "🔇"}</span>
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
              O servidor deve estar no ar em <code>localhost:3939</code> (<code>npm run dev</code>). Para ver a
              interface sem servidor, abra <code>?mock=1</code>.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const interactive =
    state.status === "active" && state.seats[state.turn].kind === "human" && previewPly === null && (connected || mock);

  /*
   * Destaque no tabuleiro:
   * - ao vivo, o `state.highlight` só vale enquanto o ply for o mesmo em que nasceu;
   * - em revisão, vale o desenho anexado ao comentário daquele ply (§3.6).
   */
  const reviewComment =
    previewPly !== null
      ? [...state.commentary].reverse().find((c) => c.ply === previewPly && c.highlight) ?? null
      : null;
  const highlight =
    previewPly !== null
      ? (reviewComment?.highlight ?? null)
      : state.highlight && state.highlight.ply === state.ply
        ? state.highlight
        : null;

  const topColor = opposite(orientation);
  const bottomColor = orientation;
  const capturedBy = (color: Color) => (color === "white" ? state.captured.byWhite : state.captured.byBlack);
  const deltaFor = (color: Color) => (color === "white" ? state.materialBalance : -state.materialBalance);

  const aiThinking = state.status === "active" && isAiSeat(state.seats[state.turn]);
  const frameMode = previewPly !== null ? "review" : aiThinking ? "thinking" : "live";
  const reviewLabel =
    previewPly === 0
      ? "Revisando a posição inicial"
      : previewMove
        ? `Revisando ${previewMove.color === "white" ? `${previewMove.moveNumber}.` : `${previewMove.moveNumber}…`} ${previewMove.san}`
        : `Revisando lance ${previewPly ?? ""}`;

  /* Onboarding (§3.7): enquanto não houver IA sentada, o Caderno dá lugar aos passos. */
  const hasAi = COLORS.some((c) => isAiSeat(state.seats[c]));
  const hasEmptySeat = COLORS.some((c) => state.seats[c].kind === "empty");
  const showWizard = !hasAi && hasEmptySeat && state.status !== "finished";

  const lastComment = [...state.commentary].reverse().find((c) => c.author !== "system") ?? null;

  /*
   * Espectador (§3.5): sem assento humano e com as duas IAs na mesa, cada placa
   * vira balão de professor com a última fala daquela voz — brancas em `--ink`,
   * pretas em `--ink-2`.
   */
  const spectator = COLORS.every((c) => isAiSeat(state.seats[c]));
  /**
   * A fala mais recente daquela voz pode estar no feed (`Commentary`) ou colada
   * ao lance (`make_move.comment`) — bots costumam usar o segundo caminho.
   */
  const plateComment = (color: Color): Commentary | null => {
    if (!spectator) return null;
    const comment = [...state.commentary].reverse().find((c) => c.author === color) ?? null;
    const move = [...state.history].reverse().find((m) => m.color === color && m.comment);
    if (!move?.comment) return comment;
    if (comment && Date.parse(comment.timestamp) >= Date.parse(move.timestamp)) return comment;
    return {
      id: `move-comment-${move.ply}`,
      ply: move.ply,
      author: color,
      authorName: state.seats[color].name,
      category: "reaction",
      text: move.comment,
      timestamp: move.timestamp,
    };
  };

  /** Escolha inicial do diálogo "trocar de modelo": o que o assento já usa. */
  const botChoice = (color: Color): BotChoice => {
    const bot = state.seats[color].bot;
    if (!bot) return {};
    return bot.profileId ? { profileId: bot.profileId } : { providerId: bot.providerId, model: bot.model };
  };

  const plateProps = (color: Color) => ({
    color,
    state,
    server,
    captured: capturedBy(color),
    materialDelta: deltaFor(color),
    onOpenHelp: () => setShowHelp(true),
    latestComment: plateComment(color),
    onBotAction: handleBotAction,
    busy,
  });

  const boardTools = (
    <BoardTools
      state={state}
      pgnUrl={api.pgnUrl}
      busy={busy}
      preset={board.preset}
      onPreset={board.set}
      onFlip={() => setFlipped((f) => !f)}
      onCopyFen={() => void copyFen()}
      onTakeback={() => void run(() => api.takeback())}
      onClearHighlight={() => void run(() => api.clearHighlight())}
    />
  );

  const gameActions = (
    <GameActions
      state={state}
      busy={busy}
      onNewGame={() => setShowNewGame(true)}
      onResign={(color) => void run(() => api.resign(color))}
      onDraw={(color) => void run(() => api.draw(color))}
    />
  );

  return (
    <div className={`app${spectator ? " is-spectator" : ""}`}>
      {header}
      <LiveRegions state={state} />
      <main className="layout">
        <section className="col-board" aria-labelledby="mesa-title">
          <h2 id="mesa-title" className="sr-only">
            Mesa
          </h2>

          <div className={`table${state.status === "finished" ? " has-banner" : ""}`}>
            <SeatPlate {...plateProps(topColor)} />

            <GameBanner
              state={state}
              pgnUrl={api.pgnUrl}
              onReview={() => setPreviewPly(0)}
              onNewGame={() => setShowNewGame(true)}
            />

            <BoardFrame orientation={orientation} mode={frameMode} reviewLabel={reviewLabel}>
              <Board
                state={state}
                fen={displayedFen}
                previewMove={previewMove}
                isPreview={previewPly !== null}
                interactive={interactive}
                orientation={orientation}
                highlight={highlight}
                themeSignal={theme.resolved}
                reducedMotion={reducedMotion}
                onMove={handleMove}
              />
            </BoardFrame>

            <SeatPlate {...plateProps(bottomColor)} />

            <MoveRibbon
              history={state.history}
              activePly={previewPly}
              onSelect={setPreviewPly}
              liveCount={liveCount}
            />
          </div>

          {!isPhone && boardTools}
        </section>

        <aside className="col-side" aria-label="Aula">
          {/* Celular (§3.4): o último comentário fica colado ao tabuleiro. */}
          {lastComment && (
            <div className="last-bubble" aria-hidden="true">
              <Annotation
                id="bubble"
                kind="comment"
                author={lastComment.authorName}
                ink={inkFor(lastComment.author)}
                category={lastComment.category}
                timestamp={lastComment.timestamp}
                text={lastComment.text}
              />
            </div>
          )}

          {showWizard ? (
            <>
              <ConnectWizard
                state={state}
                server={server}
                wsConnected={connected || mock}
                onOpenHelp={() => setShowHelp(true)}
                onNewGame={() => setShowNewGame(true)}
              />
              {isPhone && boardTools}
              {gameActions}
            </>
          ) : (
            <>
              <Notebook
                state={state}
                selectedPly={previewPly}
                onSelectPly={setPreviewPly}
                onSend={handleMessage}
                showActionsTab={isPhone}
                reviewing={previewPly !== null}
                actions={
                  <>
                    {boardTools}
                    {gameActions}
                  </>
                }
              />
              {!isPhone && gameActions}
            </>
          )}
        </aside>
      </main>

      <Toaster toasts={toasts} onDismiss={dismiss} />

      {showNewGame && (
        <NewGameDialog
          server={server}
          onClose={() => setShowNewGame(false)}
          onSubmit={handleNewGame}
          onOpenProviders={() => {
            setShowNewGame(false);
            setShowProviders(true);
          }}
        />
      )}
      {showHelp && server && (
        <ConnectHelp
          server={server}
          state={state}
          onClose={() => setShowHelp(false)}
          {...(hasProviderLayer
            ? {
                onOpenProviders: () => {
                  setShowHelp(false);
                  setShowProviders(true);
                },
              }
            : {})}
        />
      )}
      {showProviders && <ProvidersDialog server={server} onClose={() => setShowProviders(false)} />}
      {changeBot && (
        <ChangeBotDialog
          color={changeBot}
          server={server}
          initial={botChoice(changeBot)}
          onClose={() => setChangeBot(null)}
          onSubmit={handleChangeBot}
        />
      )}
    </div>
  );
}
