/**
 * BotPlayer + BotManager em modo nativo (docs/09, fase C).
 * Sobe a API REST real numa porta efêmera e joga com o `FakeProvider` (sem rede).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GameState } from "../../shared/types.js";
import {
  botSeat,
  firstLegalProvider,
  lastUserText,
  post,
  startHarness,
  state,
  waitFor,
  type Harness,
  type StartOptions,
} from "./bot-harness.js";
import { createFakeProvider, legalMovesFromPrompt } from "../src/bots/providers/fake.js";
import { ProviderError } from "../src/bots/providers/types.js";

let harness: Harness | null = null;

async function start(opts: StartOptions = {}): Promise<Harness> {
  harness = await startHarness(opts);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/* -------------------------------- testes --------------------------- */

describe("humano vs bot", () => {
  it("joga 10 lances via REST, com comentário em cada lance do bot", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({ providers: [{ provider: fake }] });

    const created = await post(h.base, "/api/game", {
      seats: { white: { kind: "human", name: "Felipe" }, black: botSeat("fake") },
    });
    expect(created.status).toBe(200);
    expect((created.json as GameState).seats.black.kind).toBe("bot");

    for (let i = 1; i <= 10; i++) {
      const current = await state(h.base);
      if (current.status === "finished") break;
      const move = current.legalMoves[0].san;
      const res = await post(h.base, "/api/move", { move });
      expect(res.status, `lance ${move} do humano`).toBe(200);
      await waitFor(async () => (await state(h.base)).ply >= i * 2, `bot responder ao lance ${i}`);
    }

    const final = await state(h.base);
    const botMoves = final.history.filter((m) => m.by === "bot");
    expect(botMoves.length).toBe(10);
    expect(botMoves.every((m) => !!m.comment)).toBe(true);
    expect(final.seats.black.bot?.usage.calls).toBe(10);
    expect(final.seats.black.bot?.status).toBe("waiting");
  });

  it("mensagem do humano vira comentário do bot (sem jogar)", async () => {
    const fake = createFakeProvider({
      id: "fake",
      onChat: (req) => {
        if (/aluno falou com você/i.test(lastUserText(req.messages))) {
          return { toolCalls: [{ name: "comment", args: { text: "Boa pergunta: eu disputo o centro.", category: "lesson" } }] };
        }
        const legal = legalMovesFromPrompt(req);
        return { toolCalls: [{ name: "make_move", args: { move: legal[0] ?? "e5" } }] };
      },
    });
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });

    await post(h.base, "/api/message", { text: "Por que você joga assim?", to: "black" });
    await waitFor(
      async () => (await state(h.base)).commentary.some((c) => c.author === "black" && c.text.includes("disputo o centro")),
      "comentário de resposta do bot",
    );
    const after = await state(h.base);
    expect(after.ply).toBe(0); // não era a vez dele: respondeu sem jogar
  });

  it("stop aborta a rodada em curso sem executar o tool tardio", async () => {
    const fake = firstLegalProvider("fake", { latencyMs: 300 });
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });

    await post(h.base, "/api/move", { move: "e4" });
    await waitFor(async () => (await state(h.base)).seats.black.bot?.status === "thinking", "bot pensando");
    const stopped = await post(h.base, "/api/bots/black/stop");
    expect(stopped.status).toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    const after = await state(h.base);
    expect(after.ply).toBe(1); // o lance tardio NÃO foi aplicado
    expect(after.seats.black.kind).toBe("bot");
    expect(after.seats.black.bot?.status).toBe("stopped");
  });

  it("lance ilegal é recusado e o bot corrige na iteração seguinte", async () => {
    const fake = createFakeProvider({
      id: "fake",
      script: [
        { toolCalls: [{ name: "make_move", args: { move: "Ke5" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "e5", comment: "Agora sim, disputo o centro." } }] },
      ],
    });
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });
    await post(h.base, "/api/move", { move: "e4" });

    await waitFor(async () => (await state(h.base)).ply === 2, "bot corrigir o lance ilegal");
    const after = await state(h.base);
    expect(after.history[1].san).toBe("e5");
    expect(after.seats.black.bot?.usage.illegalMoves).toBe(1);
  });

  it("orçamento excedido para o bot com status budget_exceeded", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({
      providers: [{ provider: fake }],
      profiles: [
        {
          id: "pao-duro",
          name: "Bot com orçamento curto",
          providerId: "fake",
          model: "fake-1",
          role: "opponent",
          level: "beginner",
          limits: { maxTokensPerGame: 50 },
        },
      ],
    });
    await post(h.base, "/api/game", {
      seats: { white: { kind: "human" }, black: { kind: "bot", profileId: "pao-duro" } },
    });
    await post(h.base, "/api/move", { move: "e4" });

    await waitFor(async () => (await state(h.base)).seats.black.bot?.status === "budget_exceeded", "status budget_exceeded");
    const after = await state(h.base);
    expect(after.commentary.some((c) => c.author === "system" && /orçamento/i.test(c.text))).toBe(true);
  });

  it("erro 401 do provedor para o bot com status error", async () => {
    const fake = createFakeProvider({
      id: "fake",
      onChat: () => ({ error: new ProviderError("chave de API inválida ou ausente", { providerId: "fake", status: 401 }) }),
    });
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });
    await post(h.base, "/api/move", { move: "e4" });

    await waitFor(async () => (await state(h.base)).seats.black.bot?.status === "error", "status error");
    const after = await state(h.base);
    expect(after.seats.black.bot?.statusText).toContain("401");
    expect(after.ply).toBe(1);
  });
});

describe("bot vs bot", () => {
  it("chega ao fim com o Mate do Pastor scriptado", async () => {
    const white = createFakeProvider({
      id: "fake-w",
      script: [
        { toolCalls: [{ name: "make_move", args: { move: "e4" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "Bc4" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "Qh5" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "Qxf7#" } }] },
      ],
    });
    const black = createFakeProvider({
      id: "fake-b",
      script: [
        { toolCalls: [{ name: "make_move", args: { move: "e5" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "Nc6" } }] },
        { toolCalls: [{ name: "make_move", args: { move: "Nf6" } }] },
      ],
    });
    const h = await start({ providers: [{ provider: white }, { provider: black }] });

    const created = await post(h.base, "/api/game", {
      seats: {
        white: botSeat("fake-w", { role: "silent", name: "Bot Brancas" }),
        black: botSeat("fake-b", { role: "silent", name: "Bot Pretas" }),
      },
    });
    expect(created.status).toBe(200);

    await waitFor(async () => (await state(h.base)).status === "finished", "fim da partida bot vs bot", 6000);
    const final = await state(h.base);
    expect(final.result).toBe("1-0");
    expect(final.endReason).toBe("checkmate");
    expect(final.history.map((m) => m.san).join(" ")).toBe("e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#");
    expect(final.history.every((m) => m.by === "bot")).toBe(true);
  });
});

describe("ciclo de vida", () => {
  it("new_game reaproveita o bot e zera o histórico da conversa", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });
    const first = await state(h.base);
    const sessionId = first.seats.black.sessionId;

    await post(h.base, "/api/move", { move: "e4" });
    await waitFor(async () => (await state(h.base)).ply === 2, "primeiro lance do bot");

    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });
    const second = await state(h.base);
    expect(second.seats.black.sessionId).toBe(sessionId); // mesmo BotPlayer
    expect(second.ply).toBe(0);

    const callsBefore = fake.calls.length;
    await post(h.base, "/api/move", { move: "d4" });
    await waitFor(async () => (await state(h.base)).ply === 2, "lance do bot na nova partida");

    const req = fake.calls[callsBefore];
    expect(req.messages.map((m) => m.role)).toEqual(["system", "user"]); // histórico zerado
    expect(JSON.stringify(req.messages)).not.toContain("e4");
  });

  it("sit / leave controlam o assento pela REST", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: { kind: "mcp" } } });
    expect((await state(h.base)).seats.black.kind).toBe("empty");

    const sat = await post(h.base, "/api/bots/black/sit", { providerId: "fake", model: "fake-1", name: "Fakinho" });
    expect(sat.status).toBe(200);
    expect((sat.json as GameState).seats.black.kind).toBe("bot");
    expect((sat.json as GameState).seats.black.name).toBe("Fakinho");

    const left = await post(h.base, "/api/bots/black/leave");
    expect(left.status).toBe(200);
    expect((left.json as GameState).seats.black.kind).toBe("empty");
    expect((left.json as GameState).seats.black.name).toBe("Fakinho");
  });

  it("resume volta a jogar depois de um stop", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({ providers: [{ provider: fake }] });
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("fake") } });
    await post(h.base, "/api/bots/black/stop");
    await post(h.base, "/api/move", { move: "e4" });
    await new Promise((r) => setTimeout(r, 200));
    expect((await state(h.base)).ply).toBe(1);

    const resumed = await post(h.base, "/api/bots/black/resume");
    expect(resumed.status).toBe(200);
    await waitFor(async () => (await state(h.base)).ply === 2, "bot retomado joga");
  });

  it("autoResume recria o bot de uma partida salva (BOT_AUTORESUME)", async () => {
    const fake = firstLegalProvider("fake");
    const h = await start({ providers: [{ provider: fake }] });
    const created = await post(h.base, "/api/game", {
      seats: { white: { kind: "human" }, black: botSeat("fake", { name: "Fakinho" }) },
    });
    const saved = JSON.parse(JSON.stringify(created.json)) as GameState;

    // Simula o reinício do processo: bots parados, estado recarregado do current-game.json.
    h.bots.stopAll();
    h.store.loadState(saved);
    expect(h.store.getState().seats.black.kind).toBe("bot");
    expect(h.store.getState().seats.black.bot?.status).toBe("stopped");

    h.bots.autoResume();
    const resumed = await state(h.base);
    expect(resumed.seats.black.kind).toBe("bot");
    expect(resumed.seats.black.name).toBe("Fakinho");
    expect(resumed.seats.black.sessionId).not.toBe(saved.seats.black.sessionId);

    await post(h.base, "/api/move", { move: "e4" });
    await waitFor(async () => (await state(h.base)).ply === 2, "bot retomado joga");
  });

  it("autoResume libera o assento quando o provedor sumiu da configuração", async () => {
    const h = await start({ providers: [{ provider: firstLegalProvider("fake") }] });
    const created = await post(h.base, "/api/game", {
      seats: { white: { kind: "human" }, black: botSeat("fake", { name: "Fakinho" }) },
    });
    const saved = JSON.parse(JSON.stringify(created.json)) as GameState;
    h.bots.stopAll();
    h.registry.remove("fake");
    h.store.loadState(saved);
    h.bots.autoResume();

    const after = await state(h.base);
    expect(after.seats.black.kind).toBe("empty");
    expect(after.seats.black.name).toBe("Fakinho");
  });

  it("cor inválida e assento sem bot devolvem 4xx", async () => {
    const h = await start({ providers: [{ provider: firstLegalProvider("fake") }] });
    expect((await post(h.base, "/api/bots/green/stop")).status).toBe(400);
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: { kind: "human" } } });
    expect((await post(h.base, "/api/bots/black/stop")).status).toBe(404);
    expect((await post(h.base, "/api/bots/white/sit", { providerId: "fake", model: "fake-1" })).status).toBe(409);
  });
});
