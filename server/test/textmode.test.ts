/**
 * Modo texto estruturado (docs/09, fase D): parser tolerante + loop completo com o
 * `FakeProvider` respondendo só texto (nenhuma tool nativa).
 */
import { Chess } from "chess.js";
import { afterEach, describe, expect, it } from "vitest";
import type { GameState, LegalMove } from "../../shared/types.js";
import { legalMoves } from "../src/game/rules.js";
import { matchLegalMove, parseBotText, stripMarkup, textModeInstructions } from "../src/bots/textmode.js";
import { createFakeProvider, legalMovesFromPrompt } from "../src/bots/providers/fake.js";
import { botSeat, post, startHarness, state, waitFor, type Harness } from "./bot-harness.js";

const START = legalMoves(new Chess());
/** Posição onde as brancas podem rocar para os dois lados. */
const CASTLE = legalMoves(new Chess("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1"));
/** 1.e4 d5: `exd5` disponível. */
const CAPTURE = legalMoves(new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2"));
/** Peão branco em e7, pronto para promover. */
const PROMO = legalMoves(new Chess("8/4P3/8/8/8/8/8/K6k w - - 0 1"));

function move(text: string, legal: LegalMove[] = START): string | undefined {
  return parseBotText(text, legal).move;
}

describe("parseBotText — linha MOVE", () => {
  it("MOVE: Nf3", () => expect(move("MOVE: Nf3")).toBe("Nf3"));
  it("minúsculas e espaços", () => expect(move("  move :   nf3  ")).toBe("Nf3"));
  it("sinal de igual", () => expect(move("MOVE = e4")).toBe("e4"));
  it("negrito e exclamação", () => expect(move("**Lance:** e4!")).toBe("e4"));
  it('"Jogada:" em português', () => expect(move("Jogada: Nf3")).toBe("Nf3"));
  it("linha citada com >", () => expect(move("> MOVE: d4")).toBe("d4"));
  it("item de lista", () => expect(move("- MOVE: c4")).toBe("c4"));
  it("ponto final depois do lance", () => expect(move("MOVE: Nf3.")).toBe("Nf3"));
  it("parêntese depois do lance", () => expect(move("MOVE: Nf3 (desenvolvendo)")).toBe("Nf3"));
  it("lance em negrito dentro do valor", () => expect(move("MOVE: **e4**")).toBe("e4"));
  it("xeque supérfluo", () => expect(move("MOVE: Nf3+")).toBe("Nf3"));
  it("valor vazio não vira lance", () => expect(move("MOVE:")).toBeUndefined());
});

describe("parseBotText — UCI, roque e promoção", () => {
  it("UCI e2e4", () => expect(move("MOVE: e2e4")).toBe("e4"));
  it("UCI com hífen", () => expect(move("MOVE: e2-e4")).toBe("e4"));
  it("UCI g1f3", () => expect(move("MOVE: g1f3")).toBe("Nf3"));
  it("O-O", () => expect(move("MOVE: O-O", CASTLE)).toBe("O-O"));
  it("0-0 com zeros", () => expect(move("MOVE: 0-0", CASTLE)).toBe("O-O"));
  it("o-o-o minúsculo", () => expect(move("MOVE: o-o-o", CASTLE)).toBe("O-O-O"));
  it("captura exd5", () => expect(move("MOVE: exd5", CAPTURE)).toBe("exd5"));
  it("captura sem o x", () => expect(move("MOVE: ed5", CAPTURE)).toBe("exd5"));
  it("promoção SAN", () => expect(move("MOVE: e8=Q", PROMO)).toBe("e8=Q"));
  it("promoção UCI", () => expect(move("MOVE: e7e8q", PROMO)).toBe("e8=Q"));
  it("promoção em cavalo", () => expect(move("MOVE: e8=N", PROMO)).toBe("e8=N"));
});

describe("parseBotText — JSON e reasoning", () => {
  it("JSON simples", () => {
    const parsed = parseBotText('{"move": "e4", "comment": "Domino o centro."}', START);
    expect(parsed.move).toBe("e4");
    expect(parsed.comment).toBe("Domino o centro.");
    expect(parsed.source).toBe("json");
  });

  it("JSON em bloco de código", () => expect(move('```json\n{"move":"Nf3"}\n```')).toBe("Nf3"));
  it("JSON com chave em português", () => expect(move('{"lance": "d4"}')).toBe("d4"));

  it("<think> é ignorado e a linha MOVE vale", () => {
    expect(move("<think>Penso em e4, mas talvez c4 seja melhor…</think>\nMOVE: d4")).toBe("d4");
  });

  it("<think> sem fechamento não engole a resposta", () => {
    expect(stripMarkup("<think>divagando</think>MOVE: e4")).toContain("MOVE: e4");
  });
});

describe("parseBotText — varredura e recusa", () => {
  it("um único lance no texto livre", () => expect(move("Vou jogar Nf3 agora.")).toBe("Nf3"));

  it("dois lances: fica com o primeiro", () => {
    expect(move("Penso em Nf3 ou d4; acho que dá certo.")).toBe("Nf3");
  });

  it("dois lances: o negrito ganha", () => {
    expect(move("Penso em Nf3, mas jogo **d4** hoje.")).toBe("d4");
  });

  it("lance ilegal declarado é recusado", () => {
    const parsed = parseBotText("MOVE: Ke2", START);
    expect(parsed.move).toBeUndefined();
    expect(parsed.rejected).toBe("Ke2");
  });

  it("lance ilegal no JSON também é recusado", () => {
    const parsed = parseBotText('{"move": "Qh5"}', START);
    expect(parsed.move).toBeUndefined();
    expect(parsed.rejected).toBe("Qh5");
  });

  it("texto sem lance nenhum", () => {
    const parsed = parseBotText("Não sei o que fazer nesta posição.", START);
    expect(parsed.move).toBeUndefined();
    expect(parsed.rejected).toBeUndefined();
  });

  it("texto vazio", () => expect(parseBotText("", START)).toEqual({}));
});

describe("parseBotText — comentário e desenhos", () => {
  it("COMMENT: vira o comentário", () => {
    const parsed = parseBotText("MOVE: Nf3\nCOMMENT: Desenvolvo o cavalo e miro e5.", START);
    expect(parsed.move).toBe("Nf3");
    expect(parsed.comment).toBe("Desenvolvo o cavalo e miro e5.");
  });

  it("COMENTÁRIO em português, em várias linhas", () => {
    const parsed = parseBotText("MOVE: e4\nCOMENTÁRIO: Abro o centro.\nÉ o lance mais popular.", START);
    expect(parsed.comment).toBe("Abro o centro.\nÉ o lance mais popular.");
  });

  it("sem COMMENT, o resto do texto vira comentário", () => {
    const parsed = parseBotText("MOVE: e4\nQuero espaço no centro.", START);
    expect(parsed.comment).toBe("Quero espaço no centro.");
  });

  it("ARROWS vira setas", () => {
    const parsed = parseBotText("MOVE: e4\nARROWS: e2-e4, g1-f3", START);
    expect(parsed.arrows).toEqual([
      { from: "e2", to: "e4" },
      { from: "g1", to: "f3" },
    ]);
  });

  it("SETAS/CASAS em português", () => {
    const parsed = parseBotText("MOVE: e4\nSETAS: d1->h5\nCASAS: f7, e5", START);
    expect(parsed.arrows).toEqual([{ from: "d1", to: "h5" }]);
    expect(parsed.squares).toEqual([{ square: "f7" }, { square: "e5" }]);
  });

  it("comentário gigante é truncado", () => {
    const parsed = parseBotText(`MOVE: e4\nCOMMENT: ${"blá ".repeat(400)}`, START);
    expect((parsed.comment ?? "").length).toBeLessThanOrEqual(601);
  });
});

describe("matchLegalMove e instruções", () => {
  it("token curto demais não casa", () => expect(matchLegalMove("e", START)).toBeNull());
  it("caixa trocada casa", () => expect(matchLegalMove("NF3", START)).toBe("Nf3"));
  it("o formato pedido cita MOVE e COMMENT", () => {
    const text = textModeInstructions("teacher");
    expect(text).toContain("MOVE:");
    expect(text).toContain("COMMENT:");
  });
  it("papel silencioso não pede comentário", () => {
    expect(textModeInstructions("silent")).not.toContain("COMMENT:");
  });
});

/* ------------------------------------------------------------------ */
/* Loop completo em modo texto                                         */
/* ------------------------------------------------------------------ */

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Provedor de texto puro: devolve "MOVE: <1º legal>" + comentário. */
function textProvider(id: string, opts: { prefix?: string } = {}) {
  return createFakeProvider({
    id,
    onChat: (req) => {
      const legal = legalMovesFromPrompt(req);
      if (!legal.length) return { text: "COMMENT: Sem lances para jogar." };
      return { text: `${opts.prefix ?? ""}MOVE: ${legal[0]}\nCOMMENT: Escolhi ${legal[0]} porque é o que enxergo.` };
    },
  });
}

describe("loop em modo texto", () => {
  it("bot vs bot em modo texto joga uma partida até o fim", async () => {
    harness = await startHarness({
      providers: [
        { provider: textProvider("txt-w"), cfg: { toolMode: "text" } },
        { provider: textProvider("txt-b", { prefix: "<think>deixa eu ver…</think>\n" }), cfg: { toolMode: "text" } },
      ],
    });
    const h = harness;
    const created = await post(h.base, "/api/game", {
      seats: {
        white: botSeat("txt-w", { role: "silent", name: "Texto Brancas" }),
        black: botSeat("txt-b", { role: "silent", name: "Texto Pretas" }),
      },
    });
    expect(created.status).toBe(200);
    expect((created.json as GameState).seats.white.bot?.toolMode).toBe("text");

    await waitFor(async () => (await state(h.base)).status === "finished", "fim da partida em modo texto", 30_000);
    const final = await state(h.base);
    expect(final.history.length).toBeGreaterThan(10);
    expect(final.history.every((m) => m.by === "bot")).toBe(true);
    expect(["checkmate", "stalemate", "insufficient_material", "threefold_repetition", "fifty_move_rule"]).toContain(
      final.endReason,
    );
  }, 40_000);

  it('toolMode "auto" cai para texto quando o provedor não devolve tool_calls', async () => {
    harness = await startHarness({ providers: [{ provider: textProvider("auto"), cfg: { toolMode: "auto" } }] });
    const h = harness;
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("auto") } });
    expect((await state(h.base)).seats.black.bot?.toolMode).toBe("native");

    await post(h.base, "/api/move", { move: "e4" });
    await waitFor(async () => (await state(h.base)).ply === 2, "bot jogar em modo texto");
    const after = await state(h.base);
    expect(after.seats.black.bot?.toolMode).toBe("text");
    expect(after.history[1].comment).toContain("Escolhi");
  });

  it("modo texto: lance ilegal é reexplicado e o bot corrige", async () => {
    let call = 0;
    const provider = createFakeProvider({
      id: "txt",
      onChat: (req) => {
        call += 1;
        if (call === 1) return { text: "MOVE: Qh8\nCOMMENT: Acho que dá." };
        const legal = legalMovesFromPrompt(req);
        return { text: `MOVE: ${legal[0]}\nCOMMENT: Corrigido.` };
      },
    });
    harness = await startHarness({ providers: [{ provider, cfg: { toolMode: "text" } }] });
    const h = harness;
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("txt") } });
    await post(h.base, "/api/move", { move: "e4" });

    await waitFor(async () => (await state(h.base)).ply === 2, "bot corrigir em modo texto");
    const after = await state(h.base);
    expect(after.history[1].comment).toBe("Corrigido.");
    expect(call).toBe(2);
  });

  it("humano vs bot: sem lance legal o assento pausa em error (onMoveFailure=pause)", async () => {
    const provider = createFakeProvider({ id: "mudo", onChat: () => ({ text: "Não faço ideia do que jogar." }) });
    harness = await startHarness({ providers: [{ provider, cfg: { toolMode: "text" } }] });
    const h = harness;
    await post(h.base, "/api/game", { seats: { white: { kind: "human" }, black: botSeat("mudo") } });
    await post(h.base, "/api/move", { move: "e4" });

    await waitFor(async () => (await state(h.base)).seats.black.bot?.status === "error", "assento pausado");
    const after = await state(h.base);
    expect(after.ply).toBe(1);
    expect(after.commentary.some((c) => c.author === "system" && /não conseguiu jogar/i.test(c.text))).toBe(true);
  });

  it("bot vs bot: sem lance legal o servidor joga um lance aleatório (onMoveFailure=random_legal)", async () => {
    const mute = () => createFakeProvider({ id: `mudo-${Math.random().toString(16).slice(2, 8)}`, onChat: () => ({ text: "…" }) });
    const white = mute();
    const black = mute();
    harness = await startHarness({
      providers: [
        { provider: white, cfg: { toolMode: "text" } },
        { provider: black, cfg: { toolMode: "text" } },
      ],
    });
    const h = harness;
    await post(h.base, "/api/game", {
      seats: {
        white: { kind: "bot", providerId: white.id, model: "fake-1", role: "silent" },
        black: { kind: "bot", providerId: black.id, model: "fake-1", role: "silent" },
      },
    });

    await waitFor(async () => (await state(h.base)).ply >= 2, "lances automáticos em bot vs bot", 10_000);
    const after = await state(h.base);
    expect(after.commentary.some((c) => c.author === "system" && /automaticamente/i.test(c.text))).toBe(true);
  }, 15_000);
});
