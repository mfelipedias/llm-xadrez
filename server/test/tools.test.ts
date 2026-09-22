import { describe, expect, it } from "vitest";
import { GameStore } from "../src/game/store.js";
import {
  gameStateSchema,
  inputShapes,
  toolComment,
  toolEndGame,
  toolGetState,
  toolHighlight,
  toolJoinGame,
  toolLeaveGame,
  toolMakeMove,
  toolNewGame,
  toolTakeback,
  toolWaitForTurn,
  turnEventSchema,
  type ToolContext,
} from "../src/mcp/tools.js";
import * as z from "zod";
import type { GameState } from "../../shared/types.js";

function ctx(store: GameStore, id: string): ToolContext {
  store.sessionOpened(id);
  return { store, session: { id }, defaultHumanName: "Felipe" };
}

const newGameArgs = z.object(inputShapes.new_game);
const joinArgs = z.object(inputShapes.join_game);
const makeMoveArgs = z.object(inputShapes.make_move);
const waitArgs = z.object(inputShapes.wait_for_turn);
const commentArgs = z.object(inputShapes.comment);
const highlightArgs = z.object(inputShapes.highlight);
const takebackArgs = z.object(inputShapes.takeback);
const endArgs = z.object(inputShapes.end_game);

function text(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first.type === "text" && first.text ? first.text : "";
}

describe("tools — humano vs LLM", () => {
  it("new_game (defaults) senta a LLM de pretas contra o humano; structuredContent válido", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    const r = toolNewGame(c, newGameArgs.parse({}));
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Você joga de PRETAS");
    expect(text(r)).toContain("➡ Próximo passo: Não é sua vez. Chame wait_for_turn.");
    const parsed = gameStateSchema.safeParse(r.structuredContent);
    expect(parsed.success).toBe(true);
    const state = r.structuredContent as unknown as GameState;
    expect(state.seats.black).toMatchObject({ kind: "mcp", name: "Claude", sessionId: "s1" });
    expect(state.seats.white).toMatchObject({ kind: "human", name: "Felipe" });
    expect(store.seatForSession("s1")).toBe("black");
  });

  it("new_game de brancas diz que é sua vez", () => {
    const store = new GameStore();
    const r = toolNewGame(ctx(store, "s1"), newGameArgs.parse({ my_color: "white", opponent_name: "Ana" }));
    expect(text(r)).toContain("contra Ana (humano");
    expect(text(r)).toContain("É sua vez: chame make_move");
    expect(text(r)).toMatch(/Lances legais \(é a sua vez; 20\)/);
  });

  it("new_game com FEN inválido => isError", () => {
    const store = new GameStore();
    const r = toolNewGame(ctx(store, "s1"), newGameArgs.parse({ start_fen: "isso não é fen" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("FEN inválido");
  });

  it("make_move sem assento => isError not_seated", () => {
    const store = new GameStore();
    const r = toolMakeMove(ctx(store, "zzz"), makeMoveArgs.parse({ move: "e4" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Chame new_game");
  });

  it("make_move fora da vez e ilegal => isError com lances legais; sucesso => texto de próximo passo", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    toolNewGame(c, newGameArgs.parse({}));
    const early = toolMakeMove(c, makeMoveArgs.parse({ move: "e5" }));
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("Não é sua vez");

    store.applyMove("white", "e4");
    const bad = toolMakeMove(c, makeMoveArgs.parse({ move: "Nf5" }));
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Lance ilegal: "Nf5"');
    expect(text(bad)).toMatch(/Lances legais agora \(20\): .*Nf6/);
    expect(gameStateSchema.safeParse(bad.structuredContent).success).toBe(true);

    const ok = toolMakeMove(c, makeMoveArgs.parse({ move: "e5", comment: "Disputo o centro." }));
    expect(ok.isError).toBeUndefined();
    expect(text(ok)).toContain("Você jogou 1...e5. Agora é a vez das BRANCAS (Felipe). Chame wait_for_turn.");
    const state = ok.structuredContent as unknown as GameState;
    expect(state.lastMove?.comment).toBe("Disputo o centro.");
  });

  it("make_move que dá mate anuncia o resultado", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    toolNewGame(c, newGameArgs.parse({ my_color: "white" }));
    for (const [w, b] of [["e4", "e5"], ["Bc4", "Nc6"], ["Qh5", "Nf6"]]) {
      toolMakeMove(c, makeMoveArgs.parse({ move: w }));
      store.applyMove("black", b);
    }
    const r = toolMakeMove(c, makeMoveArgs.parse({ move: "Qxf7" }));
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Você jogou 4. Qxf7#. Xeque-mate! 1-0 — xeque-mate: você venceu. Partida encerrada.");
    expect((r.structuredContent as unknown as GameState).status).toBe("finished");
  });

  it("wait_for_turn: not_seated, opponent_moved, message, timeout — structuredContent segue o schema", async () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    const ns = await toolWaitForTurn(c, waitArgs.parse({}));
    expect((ns.structuredContent as { event: string }).event).toBe("not_seated");
    expect(turnEventSchema.safeParse(ns.structuredContent).success).toBe(true);

    toolNewGame(c, newGameArgs.parse({}));
    const p = toolWaitForTurn(c, waitArgs.parse({ timeout_seconds: 2 }));
    store.applyMove("white", "e4");
    const moved = await p;
    expect(turnEventSchema.safeParse(moved.structuredContent).success).toBe(true);
    const ev = moved.structuredContent as unknown as { event: string; opponentMove?: { san: string }; nextAction: string; state: GameState };
    expect(ev.event).toBe("opponent_moved");
    expect(ev.opponentMove?.san).toBe("e4");
    expect(ev.state.fen).toContain("4P3");
    expect(text(moved)).toContain("O oponente (Felipe) jogou 1. e4 (peão para e4).");
    expect(text(moved)).toMatch(/Lances legais \(é a sua vez; 20\)/);

    toolMakeMove(c, makeMoveArgs.parse({ move: "e5" }));
    const q = toolWaitForTurn(c, waitArgs.parse({ timeout_seconds: 2 }));
    store.addHumanMessage("qual a ideia?", "black");
    const msg = await q;
    expect((msg.structuredContent as { event: string }).event).toBe("message");
    expect(text(msg)).toContain("O aluno enviou 1 mensagem");
    expect(text(msg)).toContain('"qual a ideia?"');

    const to = await toolWaitForTurn({ ...c }, { timeout_seconds: 0.05 });
    expect((to.structuredContent as { event: string }).event).toBe("timeout");
    expect(text(to)).toContain("Chame wait_for_turn de novo");
  });

  it("get_state entrega mensagens pendentes uma única vez", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    toolNewGame(c, newGameArgs.parse({}));
    store.addHumanMessage("oi professor", "all");
    const first = toolGetState(c);
    expect(text(first)).toContain("Mensagens do aluno (1 nova)");
    const second = toolGetState(c);
    expect(text(second)).not.toContain("Mensagens do aluno");
  });

  it("comment e highlight retornam estado curto e atualizam o store", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    toolNewGame(c, newGameArgs.parse({}));
    const r = toolComment(c, commentArgs.parse({ text: "Repare no centro.", highlight: { squares: ["e4", { square: "d4", color: "green" }] } }));
    expect(text(r)).toContain("Comentário publicado");
    expect(text(r)).not.toContain("+------------------------+");
    expect(store.getState().commentary[0]).toMatchObject({ author: "black", category: "lesson", text: "Repare no centro." });
    expect(store.getState().highlight?.squares).toHaveLength(2);

    const h = toolHighlight(c, highlightArgs.parse({ arrows: [{ from: "c4", to: "f7", color: "red" }] }));
    expect(text(h)).toContain("1 seta");
    expect(store.getState().highlight?.arrows[0]).toEqual({ from: "c4", to: "f7", color: "red" });
    toolHighlight(c, highlightArgs.parse({ clear: true }));
    expect(store.getState().highlight).toBeNull();
  });

  it("takeback, end_game e leave_game", () => {
    const store = new GameStore();
    const c = ctx(store, "s1");
    toolNewGame(c, newGameArgs.parse({}));
    const nothing = toolTakeback(c, takebackArgs.parse({}));
    expect(nothing.isError).toBe(true);
    store.applyMove("white", "e4");
    toolMakeMove(c, makeMoveArgs.parse({ move: "e5" }));
    const tb = toolTakeback(c, takebackArgs.parse({ plies: 2 }));
    expect(text(tb)).toContain("Desfeitos 2 meio-lances");
    expect(store.getState().ply).toBe(0);

    const end = toolEndGame(c, endArgs.parse({ how: "resign" }));
    expect(text(end)).toContain("Você desistiu. Resultado: 1-0");
    const again = toolEndGame(c, endArgs.parse({ how: "draw" }));
    expect(again.isError).toBe(true);

    const left = toolLeaveGame(c);
    expect(text(left)).toContain("Você saiu do assento das PRETAS");
    expect(store.seatForSession("s1")).toBeNull();
  });
});

describe("tools — LLM vs LLM", () => {
  it("new_game(opponent: llm) + join_game; your_turn imediato; lances alternados", async () => {
    const store = new GameStore();
    const a = ctx(store, "a");
    const b = ctx(store, "b");
    const created = toolNewGame(a, newGameArgs.parse({ my_color: "white", opponent: "llm", my_name: "A" }));
    expect(text(created)).toContain('Aguardando outra LLM entrar com join_game(color: "black")');
    expect((created.structuredContent as unknown as GameState).status).toBe("waiting");

    const waitingA = toolWaitForTurn(a, waitArgs.parse({ timeout_seconds: 2 }));
    const joined = toolJoinGame(b, joinArgs.parse({ color: "black", my_name: "B" }));
    expect(joined.isError).toBeUndefined();
    expect(text(joined)).toContain("Você entrou na partida de PRETAS");
    const evA = await waitingA;
    expect((evA.structuredContent as { event: string }).event).toBe("your_turn");

    toolMakeMove(a, makeMoveArgs.parse({ move: "e4" }));
    const evB = await toolWaitForTurn(b, waitArgs.parse({ timeout_seconds: 1 }));
    expect((evB.structuredContent as { event: string; opponentMove?: { san: string } }).opponentMove?.san).toBe("e4");
    toolMakeMove(b, makeMoveArgs.parse({ move: "e5" }));
    const evA2 = await toolWaitForTurn(a, waitArgs.parse({ timeout_seconds: 1 }));
    expect((evA2.structuredContent as { event: string }).event).toBe("opponent_moved");

    // join sem cor com os dois ocupados => erro amigável
    const cctx = ctx(store, "c");
    const full = toolJoinGame(cctx, joinArgs.parse({}));
    expect(full.isError).toBe(true);
    expect(text(full)).toContain("Nenhum assento livre");
  });

  it("join_game retoma o assento após reconexão (sessão anterior fechada)", () => {
    const store = new GameStore();
    const a = ctx(store, "a");
    toolNewGame(a, newGameArgs.parse({ my_name: "Claude Code" }));
    store.sessionClosed("a");
    const a2 = ctx(store, "a2");
    const r = toolJoinGame(a2, joinArgs.parse({ color: "black", my_name: "Claude Code" }));
    expect(r.isError).toBeUndefined();
    expect(store.seatForSession("a2")).toBe("black");
  });
});
