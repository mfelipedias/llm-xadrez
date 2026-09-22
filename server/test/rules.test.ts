import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { captured, endState, legalMoves, materialBalance, normalizeMoveInput, parseMove, pieces } from "../src/game/rules.js";

describe("parseMove", () => {
  it("aceita SAN exato", () => {
    const c = new Chess();
    expect(parseMove(c, "Nf3")?.san).toBe("Nf3");
    expect(parseMove(c, "e4")?.san).toBe("e4");
  });

  it("aceita UCI (com e sem hífen)", () => {
    const c = new Chess();
    expect(parseMove(c, "g1f3")?.san).toBe("Nf3");
    expect(parseMove(c, "e2-e4")?.san).toBe("e4");
    expect(parseMove(c, "E2E4")?.san).toBe("e4");
  });

  it("normaliza roque 0-0 / o-o e ignora + # ! ?", () => {
    const c = new Chess("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1");
    expect(normalizeMoveInput("0-0")).toBe("O-O");
    expect(parseMove(c, "0-0")?.san).toBe("O-O");
    expect(parseMove(c, "o-o-o")?.san).toBe("O-O-O");
    expect(parseMove(c, "O-O+")?.san).toBe("O-O");
    expect(parseMove(new Chess(), "Nf3+")?.san).toBe("Nf3");
    expect(parseMove(new Chess(), "e4!?")?.san).toBe("e4");
  });

  it("aceita minúsculas e captura sem x", () => {
    const c = new Chess();
    expect(parseMove(c, "nf3")?.san).toBe("Nf3");
    const d = new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2");
    expect(parseMove(d, "exd5")?.san).toBe("exd5");
    expect(parseMove(d, "ed5")?.san).toBe("exd5");
  });

  it("promoção em SAN e UCI", () => {
    const c = new Chess("8/P7/8/8/8/8/8/k6K w - - 0 1");
    expect(parseMove(c, "a8=Q")?.promotion).toBe("q");
    expect(parseMove(c, "a8Q")?.promotion).toBe("q");
    expect(parseMove(c, "a7a8n")?.promotion).toBe("n");
    // UCI sem peça de promoção: assume dama
    expect(parseMove(c, "a7a8")?.promotion).toBe("q");
  });

  it("devolve null para lance ilegal ou vazio", () => {
    const c = new Chess();
    expect(parseMove(c, "Nf5")).toBeNull();
    expect(parseMove(c, "e5")).toBeNull();
    expect(parseMove(c, "")).toBeNull();
    expect(parseMove(c, "xyz")).toBeNull();
  });
});

describe("legalMoves / pieces / material / fim", () => {
  it("lista 20 lances iniciais com uci e flags", () => {
    const c = new Chess();
    const lm = legalMoves(c);
    expect(lm).toHaveLength(20);
    const nf3 = lm.find((m) => m.san === "Nf3");
    expect(nf3).toMatchObject({ uci: "g1f3", from: "g1", to: "f3", piece: "n", isCapture: false, isCheck: false, isCastle: false });
    expect(nf3).not.toHaveProperty("captured");
  });

  it("peças e material", () => {
    const c = new Chess();
    expect(pieces(c)).toHaveLength(32);
    expect(materialBalance(pieces(c))).toBe(0);
    const d = new Chess("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1");
    expect(materialBalance(pieces(d))).toBe(5);
  });

  it("capturas por cor", () => {
    const c = new Chess();
    for (const m of ["e4", "d5", "exd5", "Qxd5"]) c.move(m);
    expect(captured(c.history({ verbose: true }))).toEqual({ byWhite: ["p"], byBlack: ["p"] });
  });

  it("detecta mate e afogamento", () => {
    const mate = new Chess();
    for (const m of ["f3", "e5", "g4", "Qh4#"]) mate.move(m);
    expect(endState(mate)).toEqual({ endReason: "checkmate", result: "0-1", winner: "black" });
    const stale = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(endState(stale)).toEqual({ endReason: "stalemate", result: "1/2-1/2" });
    expect(endState(new Chess())).toBeNull();
  });
});
