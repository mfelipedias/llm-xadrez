/**
 * "IA de mentira" para testar a conexão MCP sem um cliente LLM de verdade.
 *
 * Conecta em /mcp (StreamableHTTPClientTransport), senta num assento e fica no ciclo
 * wait_for_turn ↔ make_move: joga lances de abertura simples (ou aleatórios), publica um
 * comentário com destaque (setas + casas) depois de cada lance e responde às mensagens
 * do humano com `comment`. Abra http://localhost:3939 no navegador para ver tudo acontecer.
 *
 * Uso:
 *   npm run play                         # join_game(color: black, my_name: "Claude Teste")
 *   PLAY_COLOR=white npm run play        # entra de brancas
 *   PLAY_MODE=new PLAY_COLOR=white PLAY_OPPONENT=llm npm run play   # cria partida LLM vs LLM
 *   PLAY_MODE=new PLAY_COLOR=black npm run play                     # cria partida contra o humano
 *
 * Variáveis: PLAY_URL (default http://localhost:3939), PLAY_NAME ("Claude Teste"),
 *   PLAY_COLOR (black|white|random), PLAY_MODE (join|new), PLAY_OPPONENT (human|llm, só em new),
 *   PLAY_FORCE (1 = join_game com force), PLAY_MAX_MOVES (sai depois de N lances próprios),
 *   PLAY_DELAY_MS (pausa antes de jogar, default 800), PLAY_WAIT_SECONDS (timeout do wait_for_turn, 60).
 * Termina com exit 0 quando a partida acaba (ou ao atingir PLAY_MAX_MOVES) e exit 1 em erro.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Color, GameState, LegalMove, TurnEvent } from "../shared/types.js";

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

const env = process.env;
const BASE = (env.PLAY_URL ?? "http://localhost:3939").replace(/\/$/, "");
const NAME = env.PLAY_NAME ?? "Claude Teste";
const COLOR = (env.PLAY_COLOR ?? "black") as Color | "random";
const MODE = env.PLAY_MODE === "new" ? "new" : "join";
const OPPONENT = env.PLAY_OPPONENT === "llm" ? "llm" : "human";
const FORCE = env.PLAY_FORCE === "1";
const MAX_MOVES = Number(env.PLAY_MAX_MOVES ?? 0) || Infinity;
const DELAY_MS = Number(env.PLAY_DELAY_MS ?? 800) || 0;
const WAIT_SECONDS = Math.min(120, Math.max(1, Number(env.PLAY_WAIT_SECONDS ?? 60) || 60));
const REQUEST_TIMEOUT_MS = (WAIT_SECONDS + 15) * 1000;

/** Linhas de abertura preferidas (SAN); se nenhuma for legal, joga captura ou aleatório. */
const BOOK: Record<Color, string[]> = {
  white: ["e4", "Nf3", "Bc4", "d3", "Nc3", "O-O", "h3", "Re1", "Be3"],
  black: ["e5", "Nc6", "Nf6", "Bc5", "d6", "O-O", "h6", "a6", "Be6"],
};

const log = (msg: string): void => console.log(`[play ${NAME}] ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function textOf(r: ToolResult): string {
  const first = r.content[0];
  return first && first.type === "text" && first.text ? first.text : "";
}

function headline(r: ToolResult): string {
  return textOf(r).split("\n")[0] ?? "";
}

function stateOf(r: ToolResult): GameState {
  if (!r.structuredContent) throw new Error("resposta sem structuredContent");
  return r.structuredContent as unknown as GameState;
}

function eventOf(r: ToolResult): TurnEvent & { state: GameState } {
  if (!r.structuredContent) throw new Error("resposta sem structuredContent");
  return r.structuredContent as unknown as TurnEvent & { state: GameState };
}

function pieceName(p: string): string {
  return { p: "peão", n: "cavalo", b: "bispo", r: "torre", q: "dama", k: "rei" }[p] ?? p;
}

function chooseMove(state: GameState, color: Color, played: number): LegalMove {
  const legal = state.legalMoves;
  if (legal.length === 0) throw new Error("nenhum lance legal");
  const book = BOOK[color];
  for (let i = played; i < book.length; i++) {
    const hit = legal.find((m) => m.san === book[i]);
    if (hit) return hit;
  }
  const mates = legal.filter((m) => m.san.endsWith("#"));
  if (mates.length) return mates[0];
  const captures = legal.filter((m) => m.isCapture);
  const quiet = legal.filter((m) => m.piece !== "k");
  const pool = captures.length ? captures : quiet.length ? quiet : legal;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function main(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: "llm-xadrez-play", version: "0.1.0" });
  await client.connect(transport);
  log(`conectado em ${BASE}/mcp; sessão ${transport.sessionId?.slice(0, 8) ?? "?"}`);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS })) as ToolResult;
    log(`${name}(${JSON.stringify(args).slice(0, 90)})${r.isError ? " => ERRO" : ""}: ${headline(r).slice(0, 140)}`);
    return r;
  };

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await call("leave_game").catch(() => undefined);
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Sentar.
  let seated: ToolResult;
  if (MODE === "new") {
    seated = await call("new_game", { my_color: COLOR, opponent: OPPONENT, my_name: NAME });
  } else {
    const args: Record<string, unknown> = { my_name: NAME, force: FORCE };
    if (COLOR !== "random") args.color = COLOR;
    seated = await call("join_game", args);
  }
  if (seated.isError) throw new Error(`não consegui sentar: ${headline(seated)}`);
  let state = stateOf(seated);
  let myColor: Color = (["white", "black"] as Color[]).find((c) => state.seats[c].kind === "mcp" && state.seats[c].sessionId === transport.sessionId) ?? (COLOR === "random" ? "black" : COLOR);
  log(`sentado de ${myColor === "white" ? "BRANCAS" : "PRETAS"}; oponente: ${state.seats[myColor === "white" ? "black" : "white"].name || "(vazio)"}`);

  let played = 0;
  let firstMove = true;

  while (!stopping) {
    const r = await call("wait_for_turn", { timeout_seconds: WAIT_SECONDS });
    const ev = eventOf(r);
    state = ev.state;

    if (ev.messages.length) {
      for (const m of ev.messages) {
        log(`mensagem do aluno: "${m.text}"`);
        await call("comment", {
          text: `Você perguntou: _"${m.text}"_. Boa pergunta! Como sou um script de teste, só consigo responder que li a mensagem no lance ${m.ply}. 🙂`,
          category: "reaction",
        });
      }
    }

    switch (ev.event) {
      case "not_seated": {
        log("perdi o assento; tentando entrar de novo...");
        await sleep(1000);
        const again = await call("join_game", { my_name: NAME, color: myColor, force: FORCE });
        if (again.isError) throw new Error("não consegui voltar ao assento");
        state = stateOf(again);
        played = 0;
        continue;
      }
      case "new_game": {
        log("nova partida criada pelo humano; recomeçando");
        played = 0;
        firstMove = true;
        myColor = (["white", "black"] as Color[]).find((c) => state.seats[c].sessionId === transport.sessionId) ?? myColor;
        break;
      }
      case "game_over": {
        log(`partida encerrada: ${state.result} (${state.endReason ?? "?"})`);
        await call("comment", { text: `Fim de jogo: **${state.result}** (${state.endReason ?? "?"}). Obrigado pela partida!`, category: "info" });
        await shutdown();
        return;
      }
      case "takeback":
        log("lances desfeitos pelo aluno");
        break;
      default:
        break;
    }

    if (!ev.isYourTurn || state.status !== "active") continue;

    await sleep(DELAY_MS);
    const opp = ev.opponentMove ?? state.lastMove;
    const move = chooseMove(state, myColor, played);
    const oppText = opp && opp.color !== myColor ? `Você jogou ${opp.san} (${pieceName(opp.piece)} para ${opp.to}). ` : "";
    const res = await call("make_move", {
      move: move.san,
      comment: `${oppText}Respondo com **${move.san}**: ${move.isCapture ? "capturo em " + move.to : "levo o " + pieceName(move.piece) + " para " + move.to} e sigo desenvolvendo.`,
      comment_category: "plan",
    });
    if (res.isError) {
      log(`lance recusado (${move.san}); tentando outro`);
      continue;
    }
    played += 1;
    state = stateOf(res);

    if (state.status === "active") {
      const squares: { square: string; color: string }[] = [{ square: move.to, color: "green" }];
      if (opp && opp.color !== myColor) squares.push({ square: opp.to, color: "yellow" });
      const arrows: { from: string; to: string; color: string }[] = [{ from: move.from, to: move.to, color: "green" }];
      const threat = state.legalMoves.find((m) => m.isCapture) ?? null; // capturas do oponente na posição atual
      if (threat) arrows.push({ from: threat.from, to: threat.to, color: "red" });
      await call("comment", {
        text: firstMove
          ? `Repare na seta verde: foi o meu lance (${move.san}). A casa amarela é onde você acabou de jogar${threat ? `, e a seta vermelha mostra uma captura que você pode fazer agora (${threat.san})` : ""}. Sua vez!`
          : `Seta verde: ${move.san}.${threat ? ` Atenção à seta vermelha: ${threat.san} é possível.` : ""} Sua vez!`,
        category: firstMove ? "lesson" : "warning",
        highlight: { squares, arrows },
      });
      firstMove = false;
    }

    if (played >= MAX_MOVES) {
      log(`atingi PLAY_MAX_MOVES=${MAX_MOVES}; saindo`);
      await shutdown();
      return;
    }
  }
}

main().catch((err: unknown) => {
  console.error(`[play] FALHOU: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
