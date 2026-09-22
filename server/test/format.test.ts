import { describe, expect, it } from "vitest";
import { GameStore } from "../src/game/store.js";
import { describeMove, formatHistory, formatStateForLLM, formatTurnEvent } from "../src/game/format.js";
import type { GameState } from "../../shared/types.js";

function fixState(state: GameState): GameState {
  // ids/timestamps não aparecem no texto, mas fixamos o id para o snapshot ser estável.
  return { ...state, id: "20260101-120000-3f2a" };
}

function midgameStore(): GameStore {
  const store = new GameStore({ defaultHumanName: "Felipe" });
  store.newGame({ seats: { white: { kind: "human", name: "Felipe" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
  const moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "Nf6", "Nc3", "d6", "O-O", "O-O", "h3"];
  moves.forEach((m, i) => store.applyMove(i % 2 === 0 ? "white" : "black", m));
  return store;
}

describe("formatStateForLLM", () => {
  it("posição inicial, perspectiva das pretas (não é sua vez)", () => {
    const store = new GameStore({ defaultHumanName: "Felipe" });
    store.newGame({ seats: { white: { kind: "human", name: "Felipe" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
    const text = formatStateForLLM(fixState(store.getState()), "black");
    expect(text).toMatchSnapshot();
    expect(text).toContain("# Partida 3f2a — lance 1, vez das BRANCAS (Felipe, humano)");
    expect(text).toContain('Você joga de PRETAS como "Claude"');
    expect(text).toContain("➡ Próximo passo: Não é sua vez. Chame wait_for_turn.");
    expect(text).toContain("FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(text).toContain("Lances legais: 20 para as brancas (não é sua vez; não listados).");
    expect(text).toContain("Histórico: (nenhum lance ainda)");
  });

  it("meio-jogo, perspectiva das pretas (é sua vez: lista lances legais e mensagens)", () => {
    const store = midgameStore();
    store.addHumanMessage("por que você jogou o cavalo pra f6 e não pra h5?", "black");
    const text = formatStateForLLM(fixState(store.getState()), "black");
    expect(text).toMatchSnapshot();
    expect(text).toContain("vez das PRETAS (você, LLM)");
    expect(text).toContain("Último lance: 7. h3 (Felipe)");
    expect(text).toContain("Material: igual (0)");
    expect(text).toContain("➡ Próximo passo: É sua vez: chame make_move");
    expect(text).toContain("Histórico: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. Nc3 d6 6. O-O O-O 7. h3");
    expect(text).toMatch(/Lances legais \(é a sua vez; \d+\):/);
    expect(text).toContain("Mensagens do aluno (1 nova):");
    expect(text).toContain('[lance 7] "por que você jogou o cavalo pra f6 e não pra h5?"');
    expect(text).toContain("Brancas (Felipe):");
    expect(text).toContain("Pretas (você):");
  });

  it("rotula o assento bot como 'LLM (bot)' e mostra os comentários dele", () => {
    const store = new GameStore({ defaultHumanName: "Felipe" });
    store.newGame({
      seats: {
        white: { kind: "human", name: "Felipe" },
        black: {
          kind: "bot",
          name: "Sonnet (bot)",
          sessionId: "bot:black:abc",
          bot: {
            providerId: "openrouter",
            model: "anthropic/claude-sonnet-4.6",
            toolMode: "native",
            status: "waiting",
            usage: { calls: 0, inputTokens: 0, outputTokens: 0, illegalMoves: 0 },
          },
        },
      },
    });
    store.applyMove("white", "e4");
    store.applyMove("black", "e5", { comment: "Disputo o centro." });
    // Perspectiva do humano-espectador... na prática: do próprio bot e do oponente.
    const asBot = formatStateForLLM(fixState(store.getState()), "black");
    expect(asBot).toMatchSnapshot();
    expect(asBot).toContain('Você joga de PRETAS como "Sonnet (bot)"');

    const asWhite = formatStateForLLM(fixState(store.getState()), "white");
    expect(asWhite).toContain("vez das BRANCAS (você, humano)");
    expect(asWhite).toContain("Últimos comentários de Sonnet (bot):");
    expect(asWhite).toContain("(e5) Disputo o centro.");

    store.applyMove("white", "Nf3");
    const spectator = formatStateForLLM(fixState(store.getState()), null);
    expect(spectator).toContain("vez das PRETAS (Sonnet (bot), LLM (bot))");
  });

  it("versão curta omite peças e ASCII; espectador sem lances legais", () => {
    const store = midgameStore();
    const text = formatStateForLLM(fixState(store.getState()), null, { short: true });
    expect(text).not.toContain("+------------------------+");
    expect(text).not.toContain("Brancas (");
    expect(text).toContain("Você não ocupa nenhum assento (espectador).");
    expect(text).toContain("não listados");
  });

  it("partida encerrada mostra resultado", () => {
    const store = new GameStore();
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
    for (const [c, m] of [["white", "f3"], ["black", "e5"], ["white", "g4"], ["black", "Qh4#"]] as const) store.applyMove(c, m);
    const text = formatStateForLLM(fixState(store.getState()), "black");
    expect(text).toContain("encerrada após 4 meio-lances (0-1)");
    expect(text).toContain("xeque-mate: você venceu");
    expect(text).toContain("Lances legais: nenhum (partida encerrada).");
  });

  it("mostra os últimos 3 comentários do oponente LLM (modo LLM vs LLM)", () => {
    const store = new GameStore();
    store.newGame({ seats: { white: { kind: "mcp", name: "A", sessionId: "a" }, black: { kind: "mcp", name: "B", sessionId: "b" } } });
    for (let i = 1; i <= 4; i++) store.addComment("white", `comentário ${i}`, "lesson");
    const text = formatStateForLLM(fixState(store.getState()), "black");
    expect(text).toContain("Últimos comentários de A:");
    expect(text).not.toContain("comentário 1");
    expect(text).toContain("comentário 4");
  });

  it("fica abaixo de ~1500 tokens numa partida longa", () => {
    const store = new GameStore();
    store.newGame({ seats: { white: { kind: "human" }, black: { kind: "mcp", name: "Claude", sessionId: "s1" } } });
    // 40 lances de cavalo indo e voltando (sem repetição tripla? não importa: a regra só encerra via endState)
    const seq = ["Nf3", "Nf6", "Ng1", "Ng8"];
    let ply = 0;
    while (ply < 80 && store.getState().status === "active") {
      store.applyMove(ply % 2 === 0 ? "white" : "black", seq[ply % 4]);
      ply++;
    }
    const text = formatStateForLLM(store.getState(), "black");
    expect(text.length).toBeLessThan(6000);
  });
});

describe("formatTurnEvent / describeMove / formatHistory", () => {
  it("descreve lances", () => {
    const store = midgameStore();
    const bxf7 = store.applyMove("black", "Bxf2+");
    expect(describeMove(bxf7)).toBe("bispo captura peão em f2, xeque!");
    expect(formatHistory(store.getState().history)).toContain("7. h3 Bxf2+");
  });

  it("prefixa o evento opponent_moved", async () => {
    const store = midgameStore();
    const ev = await store.waitForTurn("black", 50);
    const text = formatTurnEvent(ev, fixState(store.getState()), "black");
    expect(text.startsWith("O oponente (Felipe) jogou 7. h3 (peão para h3).")).toBe(true);
    expect(text).toContain("➡ Próximo passo: É sua vez");
  });

  it("timeout e not_seated", () => {
    const store = midgameStore();
    const state = fixState(store.getState());
    const t = formatTurnEvent({ event: "timeout", isYourTurn: false, messages: [], waitedSeconds: 60, nextAction: "x" }, state, "black");
    expect(t).toContain("Nada aconteceu em 60 s. Chame wait_for_turn de novo");
    const n = formatTurnEvent({ event: "not_seated", isYourTurn: false, messages: [], waitedSeconds: 0, nextAction: "x" }, state, null);
    expect(n).toContain("Chame new_game ou join_game");
  });
});
