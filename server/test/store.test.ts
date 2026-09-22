import { describe, expect, it } from "vitest";
import { GameError, GameStore, botSessionId, emptyBotUsage, isAgentSeat } from "../src/game/store.js";
import type { BotSeatInfo, Color, GameState } from "../../shared/types.js";

function humanVsLlm(sessionId = "s1"): GameStore {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  store.newGame({
    seats: { white: { kind: "human", name: "Felipe" }, black: { kind: "mcp", name: "Claude", sessionId } },
  });
  store.sessionOpened(sessionId);
  return store;
}

function botInfo(over: Partial<BotSeatInfo> = {}): BotSeatInfo {
  return {
    providerId: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    toolMode: "native",
    status: "waiting",
    usage: emptyBotUsage(),
    ...over,
  };
}

/** Humano de brancas contra um bot de pretas (sessão sintética, como o BotManager fará). */
function humanVsBot(sessionId = botSessionId("black", "abc")): { store: GameStore; sessionId: string } {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  store.sessionOpened(sessionId);
  store.newGame({
    seats: {
      white: { kind: "human", name: "Felipe" },
      black: { kind: "bot", name: "Sonnet (bot)", sessionId, bot: botInfo() },
    },
  });
  return { store, sessionId };
}

describe("GameStore — partida e lances", () => {
  it("nova partida: estado inicial coerente", () => {
    const store = humanVsLlm();
    const s = store.getState();
    expect(s.status).toBe("active");
    expect(s.turn).toBe("white");
    expect(s.ply).toBe(0);
    expect(s.moveNumber).toBe(1);
    expect(s.legalMoves).toHaveLength(20);
    expect(s.seats.white).toEqual({ kind: "human", name: "Felipe" });
    expect(s.seats.black).toMatchObject({ kind: "mcp", name: "Claude", sessionId: "s1" });
    expect(s.pgn).toContain('[White "Felipe"]');
    expect(s.pgn).toContain('[Black "Claude"]');
  });

  it("assento vazio => status waiting; lance recusado", () => {
    const store = new GameStore();
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "empty" } } });
    expect(store.getState().status).toBe("waiting");
    expect(() => store.applyMove("white", "e4")).toThrowError(GameError);
  });

  it("lance humano e lance mcp; histórico e lastMove", () => {
    const store = humanVsLlm();
    const rec = store.applyMove("white", "e4");
    expect(rec).toMatchObject({ ply: 1, moveNumber: 1, color: "white", san: "e4", uci: "e2e4", by: "human" });
    const rec2 = store.applyMove("black", "e7e5", { comment: "Disputo o centro." });
    expect(rec2).toMatchObject({ ply: 2, moveNumber: 1, color: "black", san: "e5", by: "mcp", comment: "Disputo o centro." });
    const s = store.getState();
    expect(s.history.map((m) => m.san)).toEqual(["e4", "e5"]);
    expect(s.lastMove?.san).toBe("e5");
    expect(s.pgn).toContain("{Disputo o centro.}");
    expect(s.moveNumber).toBe(2);
  });

  it("lance ilegal => GameError com legalMoves", () => {
    const store = humanVsLlm();
    try {
      store.applyMove("white", "Nf5");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GameError);
      const e = err as GameError;
      expect(e.code).toBe("illegal_move");
      expect(e.legalMoves).toHaveLength(20);
      expect(e.legalMoves).toContain("Nf3");
    }
    expect(store.getState().ply).toBe(0);
  });

  it("não é sua vez", () => {
    const store = humanVsLlm();
    expect(() => store.applyMove("black", "e5")).toThrowError(/Não é sua vez/);
  });

  it("takeback desfaz lances, limpa highlight e reabre a partida", () => {
    const store = humanVsLlm();
    for (const [c, m] of [["white", "e4"], ["black", "e5"], ["white", "Nf3"]] as const) store.applyMove(c, m);
    store.setHighlight("black", { squares: [{ square: "e4" }], arrows: [] });
    store.takeback(2, "black");
    const s = store.getState();
    expect(s.history.map((m) => m.san)).toEqual(["e4"]);
    expect(s.turn).toBe("black");
    expect(s.highlight).toBeNull();
    expect(s.fen).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    expect(() => store.takeback(5, "black")).not.toThrow(); // limita ao histórico
    expect(store.getState().ply).toBe(0);
    expect(() => store.takeback(1, "black")).toThrowError(/Não há lances/);
  });

  it("fim por mate (Mate do Louco) => finished, vencedor, PGN arquivado", () => {
    const store = humanVsLlm();
    const archived: { id: string; pgn: string }[] = [];
    store.on("archive", (ev: { id: string; pgn: string }) => archived.push(ev));
    store.applyMove("white", "f3");
    store.applyMove("black", "e5");
    store.applyMove("white", "g4");
    const last = store.applyMove("black", "Qh4");
    expect(last.isCheckmate).toBe(true);
    expect(last.san).toBe("Qh4#");
    const s = store.getState();
    expect(s.status).toBe("finished");
    expect(s.result).toBe("0-1");
    expect(s.endReason).toBe("checkmate");
    expect(s.winner).toBe("black");
    expect(s.legalMoves).toEqual([]);
    expect(archived).toHaveLength(1);
    expect(archived[0].pgn).toContain('[Result "0-1"]');
    expect(archived[0].pgn).toContain("Qh4#");
    expect(() => store.applyMove("white", "a3")).toThrowError(/já terminou/);
    // takeback pós-mate reabre
    store.takeback(1, "black");
    expect(store.getState().status).toBe("active");
  });

  it("desistência e empate acordado", () => {
    const store = humanVsLlm();
    store.endGame("resignation", "white");
    expect(store.getState()).toMatchObject({ status: "finished", result: "0-1", winner: "black", endReason: "resignation" });
    const store2 = humanVsLlm();
    store2.endGame("draw_agreed", "black");
    expect(store2.getState()).toMatchObject({ status: "finished", result: "1/2-1/2", endReason: "draw_agreed" });
  });

  it("oferta de empate do humano vira mensagem para a LLM; aceitar via endGame", () => {
    const store = humanVsLlm();
    const { accepted } = store.offerDraw("white");
    expect(accepted).toBe(false);
    expect(store.getState().drawOffer?.by).toBe("white");
    expect(store.pendingMessages("black")).toHaveLength(1);
    store.endGame("draw_agreed", "black");
    expect(store.getState().result).toBe("1/2-1/2");
  });

  it("newGame arquiva a partida anterior com >= 2 lances e mantém sessão sentada com evento new_game", async () => {
    const store = humanVsLlm();
    const archived: string[] = [];
    store.on("archive", (ev: { id: string }) => archived.push(ev.id));
    store.applyMove("white", "e4");
    store.applyMove("black", "e5");
    const oldId = store.getState().id;
    store.newGame({ seats: { white: { kind: "human", name: "Felipe" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
    expect(archived).toEqual([oldId]);
    expect(store.getState().ply).toBe(0);
    const ev = await store.waitForTurn("black", 50);
    expect(ev.event).toBe("new_game");
  });
});

describe("GameStore — waitForTurn", () => {
  it("acorda com lance do oponente", async () => {
    const store = humanVsLlm();
    const p = store.waitForTurn("black", 2000, { sessionId: "s1" });
    expect(store.waiterCount).toBe(1);
    store.applyMove("white", "e4");
    const ev = await p;
    expect(ev.event).toBe("opponent_moved");
    expect(ev.opponentMove?.san).toBe("e4");
    expect(ev.isYourTurn).toBe(true);
    expect(ev.nextAction).toMatch(/make_move/);
    expect(store.waiterCount).toBe(0);
  });

  it("retorna imediatamente your_turn se já é a vez", async () => {
    const store = humanVsLlm();
    store.applyMove("white", "e4");
    store.markDelivered("black");
    // consome o opponent_moved enfileirado
    const first = await store.waitForTurn("black", 50);
    expect(first.event).toBe("opponent_moved");
    const second = await store.waitForTurn("black", 50);
    expect(second.event).toBe("your_turn");
    expect(second.opponentMove?.san).toBe("e4");
  });

  it("acorda com mensagem do humano e marca como entregue", async () => {
    const store = humanVsLlm();
    const p = store.waitForTurn("black", 2000);
    store.addHumanMessage("por que e4?", "all");
    const ev = await p;
    expect(ev.event).toBe("message");
    expect(ev.messages).toHaveLength(1);
    expect(ev.messages[0].text).toBe("por que e4?");
    expect(ev.isYourTurn).toBe(false);
    expect(store.pendingMessages("black")).toHaveLength(0);
    // segunda espera: nada pendente => timeout
    const ev2 = await store.waitForTurn("black", 30);
    expect(ev2.event).toBe("timeout");
  });

  it("timeout quando nada acontece (sem bloquear)", async () => {
    const store = humanVsLlm();
    const t0 = Date.now();
    const ev = await store.waitForTurn("black", 40);
    expect(ev.event).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(ev.nextAction).toMatch(/wait_for_turn/);
    expect(store.waiterCount).toBe(0);
  });

  it("fila não perde eventos enquanto ninguém espera; prioridade game_over > opponent_moved > message", async () => {
    const store = humanVsLlm();
    store.addHumanMessage("oi", "black");
    store.applyMove("white", "e4");
    const ev = await store.waitForTurn("black", 50);
    expect(ev.event).toBe("opponent_moved");
    expect(ev.messages.map((m) => m.text)).toEqual(["oi"]);

    store.applyMove("black", "e5");
    store.applyMove("white", "Bc4");
    store.applyMove("black", "Nc6");
    store.applyMove("white", "Qh5");
    store.applyMove("black", "Nf6");
    store.applyMove("white", "Qxf7#");
    const over = await store.waitForTurn("black", 50);
    expect(over.event).toBe("game_over");
    expect(over.opponentMove?.san).toBe("Qxf7#");
    expect(over.nextAction).toMatch(/encerrada/);
  });

  it("evento opponent_moved obsoleto é descartado depois que o jogador já jogou", async () => {
    const store = humanVsLlm();
    store.applyMove("white", "e4");
    store.applyMove("black", "e5"); // jogou sem esperar
    const ev = await store.waitForTurn("black", 30);
    expect(ev.event).toBe("timeout");
  });

  it("takeback do humano gera evento takeback para a LLM", async () => {
    const store = humanVsLlm();
    store.applyMove("white", "e4");
    store.applyMove("black", "e5");
    store.takeback(2, "human");
    const ev = await store.waitForTurn("black", 50);
    expect(ev.event).toBe("takeback");
  });

  it("abort signal cancela a espera e limpa o waiter", async () => {
    const store = humanVsLlm();
    const ac = new AbortController();
    const p = store.waitForTurn("black", 5000, { signal: ac.signal, sessionId: "s1" });
    ac.abort();
    const ev = await p;
    expect(ev.event).toBe("timeout");
    expect(store.waiterCount).toBe(0);
  });

  it("fechar a sessão resolve o waiter daquela sessão", async () => {
    const store = humanVsLlm();
    const p = store.waitForTurn("black", 5000, { sessionId: "s1" });
    store.sessionClosed("s1");
    const ev = await p;
    expect(ev.event).toBe("timeout");
    expect(store.waiterCount).toBe(0);
  });
});

describe("GameStore — assentos e retomada", () => {
  it("join_game na cor livre; opponent_joined e your_turn para quem esperava", async () => {
    const store = new GameStore();
    store.sessionOpened("a");
    store.newGame({ seats: { white: { kind: "mcp", name: "A", sessionId: "a" }, black: { kind: "empty" } }, bySessionId: "a" });
    expect(store.getState().status).toBe("waiting");
    const p = store.waitForTurn("white", 2000, { sessionId: "a" });
    store.sessionOpened("b");
    const color = store.joinGame({ sessionId: "b", name: "B" });
    expect(color).toBe("black");
    const ev = await p;
    expect(ev.event).toBe("your_turn");
    expect(store.getState().status).toBe("active");
  });

  it("assento ocupado por sessão ativa exige force; sessão fechada pode ser retomada", () => {
    const store = humanVsLlm("s1");
    store.sessionOpened("s2");
    expect(() => store.joinGame({ sessionId: "s2", color: "black", name: "Outra" })).toThrowError(/force/);
    // mesmo nome => retoma
    expect(store.joinGame({ sessionId: "s2", color: "black", name: "Claude" })).toBe("black");
    expect(store.getState().seats.black.sessionId).toBe("s2");
    // sessão s2 fechou; s3 retoma sem force
    store.sessionClosed("s2");
    store.sessionOpened("s3");
    expect(store.joinGame({ sessionId: "s3", color: "black", name: "Nova" })).toBe("black");
    expect(store.seatForSession("s3")).toBe("black");
    expect(store.seatForSession("s2")).toBeNull();
  });

  it("sessão ociosa há mais de 2 min pode ser retomada", () => {
    let t = 1_000_000;
    const store = new GameStore({ now: () => t });
    store.sessionOpened("s1");
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
    store.sessionOpened("s2");
    expect(() => store.joinGame({ sessionId: "s2", color: "black", name: "Outra" })).toThrowError(GameError);
    t += 121_000;
    expect(store.joinGame({ sessionId: "s2", color: "black", name: "Outra" })).toBe("black");
  });

  it("assento humano só com force; força vira mcp", () => {
    const store = humanVsLlm();
    store.sessionOpened("s2");
    expect(() => store.joinGame({ sessionId: "s2", color: "white", name: "X" })).toThrowError(/humano/);
    expect(store.joinGame({ sessionId: "s2", color: "white", name: "X", force: true })).toBe("white");
    expect(store.getState().seats.white.kind).toBe("mcp");
  });

  it("dois assentos livres sem color => erro; nenhum livre => erro", () => {
    const store = new GameStore();
    store.newGame({ seats: { white: { kind: "empty" }, black: { kind: "empty" } } });
    expect(() => store.joinGame({ sessionId: "x" })).toThrowError(/informe color/);
    const full = humanVsLlm();
    store.sessionOpened("s1");
    expect(() => full.joinGame({ sessionId: "z" })).toThrowError(/Nenhum assento livre/);
  });

  it("unseat libera o assento e acorda o waiter como not_seated", async () => {
    const store = humanVsLlm();
    const p = store.waitForTurn("black", 5000, { sessionId: "s1" });
    store.unseat("black");
    expect((await p).event).toBe("not_seated");
    expect(store.getState().seats.black.kind).toBe("empty");
    expect(store.getState().status).toBe("waiting");
  });

  it("touchSession atualiza lastSeenAt e serverInfo lista sessões", () => {
    const store = humanVsLlm();
    store.touchSession("s1");
    expect(store.getState().seats.black.lastSeenAt).toBeTruthy();
    const info = store.serverInfo("0.1.0", "http://localhost:3939/mcp");
    expect(info.mcpSessions).toEqual([expect.objectContaining({ sessionId: "s1", seat: "black", name: "Claude" })]);
  });
});

describe("GameStore — persistência (loadState)", () => {
  it("restaura histórico, comentários e transforma assentos mcp em empty", () => {
    const store = humanVsLlm();
    store.applyMove("white", "e4");
    store.applyMove("black", "e5", { comment: "centro" });
    store.addComment("black", "Bom lance!", "praise", { squares: [{ square: "e4", color: "green" }], arrows: [] });
    const saved: GameState = JSON.parse(JSON.stringify(store.getState())) as GameState;

    const fresh = new GameStore();
    fresh.loadState(saved);
    const s = fresh.getState();
    expect(s.id).toBe(saved.id);
    expect(s.history.map((m) => m.san)).toEqual(["e4", "e5"]);
    expect(s.fen).toBe(saved.fen);
    expect(s.commentary).toHaveLength(1);
    expect(s.highlight?.squares[0].square).toBe("e4");
    expect(s.seats.white.kind).toBe("human");
    expect(s.seats.black.kind).toBe("empty");
    expect(s.status).toBe("waiting");
    expect(s.pgn).toContain("{centro}");
  });
});

/* ------------------------------------------------------------------ */
/* Assentos `bot` (docs/09, fase A)                                    */
/* ------------------------------------------------------------------ */

describe("GameStore — assento bot", () => {
  it("isAgentSeat cobre mcp e bot, mas não humano/vazio", () => {
    expect(isAgentSeat({ kind: "mcp" })).toBe(true);
    expect(isAgentSeat({ kind: "bot" })).toBe(true);
    expect(isAgentSeat({ kind: "human" })).toBe(false);
    expect(isAgentSeat({ kind: "empty" })).toBe(false);
  });

  it("senta o bot com bot info e joga: by = 'bot' no histórico", () => {
    const { store } = humanVsBot();
    const s = store.getState();
    expect(s.status).toBe("active");
    expect(s.seats.black).toMatchObject({ kind: "bot", name: "Sonnet (bot)" });
    expect(s.seats.black.bot).toMatchObject({ providerId: "openrouter", model: "anthropic/claude-sonnet-4.6", status: "waiting" });
    store.applyMove("white", "e4");
    const rec = store.applyMove("black", "e5", { comment: "Disputo o centro." });
    expect(rec.by).toBe("bot");
    expect(store.getState().pgn).toContain('[Black "Sonnet (bot)"]');
  });

  it("seatForSession encontra o bot pela sessão sintética", () => {
    const { store, sessionId } = humanVsBot();
    expect(sessionId.startsWith("bot:black:")).toBe(true);
    expect(store.seatForSession(sessionId)).toBe("black");
    expect(store.seatForSession("bot:black:outro")).toBeNull();
  });

  it("serverInfo não lista a sessão sintética do bot", () => {
    const { store } = humanVsBot();
    store.sessionOpened("mcp-1");
    const info = store.serverInfo("0.1.0", "http://localhost:3939/mcp");
    expect(info.mcpSessions.map((s) => s.sessionId)).toEqual(["mcp-1"]);
  });

  it("recebe opponent_moved quando o humano joga", async () => {
    const { store, sessionId } = humanVsBot();
    const p = store.waitForTurn("black", 2000, { sessionId });
    store.applyMove("white", "e4");
    const ev = await p;
    expect(ev.event).toBe("opponent_moved");
    expect(ev.opponentMove?.san).toBe("e4");
    expect(ev.isYourTurn).toBe(true);
  });

  it("recebe message do humano (e a marca entregue)", async () => {
    const { store, sessionId } = humanVsBot();
    const p = store.waitForTurn("black", 2000, { sessionId });
    store.addHumanMessage("por que e4?", "black");
    const ev = await p;
    expect(ev.event).toBe("message");
    expect(ev.messages.map((m) => m.text)).toEqual(["por que e4?"]);
    expect(store.pendingMessages("black")).toHaveLength(0);
  });

  it("recebe takeback do humano", async () => {
    const { store, sessionId } = humanVsBot();
    store.applyMove("white", "e4");
    store.applyMove("black", "e5");
    store.takeback(2, "human");
    const ev = await store.waitForTurn("black", 50, { sessionId });
    expect(ev.event).toBe("takeback");
  });

  it("recebe game_over e new_game; oferta de empate vira mensagem", async () => {
    const { store, sessionId } = humanVsBot();
    store.offerDraw("white");
    expect(store.pendingMessages("black")).toHaveLength(1);
    store.markDelivered("black");
    store.endGame("resignation", "white");
    expect((await store.waitForTurn("black", 50, { sessionId })).event).toBe("game_over");

    store.newGame({
      seats: {
        white: { kind: "human", name: "Felipe" },
        black: { kind: "bot", name: "Sonnet (bot)", sessionId, bot: botInfo() },
      },
    });
    expect((await store.waitForTurn("black", 50, { sessionId })).event).toBe("new_game");
  });

  it("updateBot emite 'bot' sem emitir 'change' e acumula uso", () => {
    const { store } = humanVsBot();
    const changes: number[] = [];
    const bots: { color: Color; bot: BotSeatInfo }[] = [];
    store.on("change", () => changes.push(1));
    store.on("bot", (color: Color, bot: BotSeatInfo) => bots.push({ color, bot }));

    store.updateBot("black", { status: "thinking", thinkingSince: "2026-09-22T10:00:00.000Z" });
    store.updateBot("black", { status: "waiting", usage: { calls: 1, inputTokens: 900, outputTokens: 60, illegalMoves: 0 } });

    expect(changes).toHaveLength(0);
    expect(bots.map((b) => b.bot.status)).toEqual(["thinking", "waiting"]);
    const seat = store.getState().seats.black;
    expect(seat.bot).toMatchObject({ status: "waiting", usage: { calls: 1, inputTokens: 900, outputTokens: 60 } });
    // Modelo/provedor preservados pelo patch parcial.
    expect(seat.bot?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(store.updateBot("white", { status: "error" })).toBeNull();
  });

  it("join_game só toma o assento do bot com force", () => {
    const { store } = humanVsBot();
    store.sessionOpened("mcp-1");
    expect(() => store.joinGame({ sessionId: "mcp-1", color: "black", name: "Claude" })).toThrowError(/bot do servidor/);
    expect(store.joinGame({ sessionId: "mcp-1", color: "black", name: "Claude", force: true })).toBe("black");
    expect(store.getState().seats.black.kind).toBe("mcp");
  });

  it("loadState mantém o assento bot (BOT_AUTORESUME) e o esvazia quando desligado", () => {
    const { store } = humanVsBot();
    store.applyMove("white", "e4");
    store.updateBot("black", { status: "thinking", usage: { calls: 3, inputTokens: 1000, outputTokens: 100, illegalMoves: 1 } });
    const saved: GameState = JSON.parse(JSON.stringify(store.getState())) as GameState;

    const resumed = new GameStore();
    resumed.loadState(saved);
    const seat = resumed.getState().seats.black;
    expect(seat.kind).toBe("bot");
    expect(seat.sessionId).toBeUndefined();
    expect(seat.bot).toMatchObject({ providerId: "openrouter", status: "stopped", usage: { calls: 3, illegalMoves: 1 } });

    const dropped = new GameStore({ restoreBots: false });
    dropped.loadState(saved);
    expect(dropped.getState().seats.black).toEqual({ kind: "empty", name: "Sonnet (bot)" });
  });
});
