/**
 * Histórico do bot (docs/09, seção 3.3): as rodadas antigas guardam a conversa, não o estado.
 */
import { describe, expect, it } from "vitest";
import { compactRound } from "../src/bots/player.js";
import { GameStore } from "../src/game/store.js";
import { formatTurnEvent } from "../src/game/format.js";
import type { TurnEvent } from "../../shared/types.js";
import type { ChatMessage } from "../src/bots/providers/types.js";

function stateAfterE4(): GameStore {
  const store = new GameStore();
  store.newGame({ seats: { white: { kind: "human", name: "Marcos" }, black: { kind: "mcp", name: "Bot", sessionId: "s1" } } });
  store.applyMove("white", "e4");
  return store;
}

describe("compactRound", () => {
  it("tira o estado da mensagem do evento e deixa só a 1ª linha dos resultados de tool", () => {
    const store = stateAfterE4();
    const state = store.getState();
    const ev = { event: "your_turn", isYourTurn: true, opponentMove: state.lastMove, messages: [], waitedSeconds: 0 } as unknown as TurnEvent;
    const round: ChatMessage[] = [
      { role: "user", content: `${formatTurnEvent(ev, state, "black")}\n\nÉ a sua vez.` },
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "make_move", args: { move: "e5" } }] },
      { role: "tool", toolCallId: "c1", name: "make_move", content: "Você jogou 1...e5. Agora é a vez das BRANCAS.\n\n# Partida x\nFEN: ..." },
    ];
    const out = compactRound(round);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "É sua vez. Último lance do oponente: 1. e4 (peão para e4)." });
    expect(out[1]).toBe(round[1]);
    expect(out[2]).toMatchObject({ role: "tool", toolCallId: "c1", content: "Você jogou 1...e5. Agora é a vez das BRANCAS." });
  });

  it("mantém as mensagens do aluno", () => {
    const store = stateAfterE4();
    const state = store.getState();
    const msg = { id: "m1", text: "por que e5?", to: "all", ply: 1, at: "2026-09-24T00:00:00.000Z", deliveredTo: [] };
    const ev = { event: "message", isYourTurn: false, messages: [msg], waitedSeconds: 0 } as unknown as TurnEvent;
    const [first] = compactRound([{ role: "user", content: formatTurnEvent(ev, state, "black") }]);
    expect(first.content).toBe('O aluno enviou 1 mensagem (veja "Mensagens do aluno" abaixo).\nMensagens do aluno (1 nova):\n - [lance 1] (para todos) "por que e5?"');
  });
});
