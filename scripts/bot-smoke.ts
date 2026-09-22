/**
 * Smoke dos bots internos (docs/09, fases C e F) contra o **servidor real**, pela API REST.
 *
 * Uso:
 *   npm run smoke:bot                                 # provedor "fake" (determinístico, sem rede)
 *   npm run smoke:bot -- --provider lmstudio          # local, só roda se :1234 responder
 *   npm run smoke:bot -- --provider ollama            # local, só roda se :11434 responder
 *   npm run smoke:bot -- --provider openrouter        # só roda com OPENROUTER_API_KEY
 *   npm run smoke:bot -- --provider anthropic         # só roda com ANTHROPIC_API_KEY
 *   npm run smoke:bot -- --provider ollama --model qwen3:8b
 *   SMOKE_URL=http://localhost:3939 npm run smoke:bot
 *
 * (`PROVIDER=`/`MODEL=` no ambiente continuam valendo, como atalho dos flags.)
 *
 * Com `fake` (default) o servidor sobe com `BOT_FAKE_PROVIDER=1`, que injeta o provedor
 * determinístico em memória: nenhuma chamada de rede, nenhum custo.
 *
 * Com qualquer outro provedor há um **teste de ambiente antes de tudo** (docs/09, fase F):
 * locais precisam responder em `GET <baseUrl>/models`; pagos precisam da chave no ambiente
 * e do modelo na lista. Se faltar qualquer coisa, o smoke imprime **SKIP** e sai com 0 —
 * nunca falha por causa de ambiente. Em qualquer provedor real ele sobe um servidor próprio
 * com um `providers.json` temporário cujo perfil limita a partida a US$ 0,05 e 4 lances.
 *
 * Termina com "OK", "SKIP" (exit 0) ou "FALHOU" (exit 1).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PRESETS } from "../server/src/bots/providers/registry.js";
import type { BotProfile, GameState, ProviderPublic } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

// As chaves moram no `.env` (gitignored), como no servidor: o preflight precisa enxergá-las.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

/* ------------------------------------------------------------------ */
/* Argumentos: --provider/--model (ou PROVIDER=/MODEL= no ambiente)     */
/* ------------------------------------------------------------------ */

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1].trim();
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3).trim() : undefined;
}

const PROVIDER = (flag("provider") ?? process.env.PROVIDER ?? "fake").trim();
const IS_FAKE = PROVIDER === "fake";
/** Resolvido no preflight quando o usuário não passa `--model`. */
let MODEL = (flag("model") ?? process.env.MODEL ?? (IS_FAKE ? "fake-1" : "")).trim();

/** Perfil temporário com limites apertados para provedores pagos (docs/09, fase F). */
const SMOKE_PROFILE_ID = "smoke";
/** Usa `profileId` (limites) em vez de `providerId`+`model` quando temos providers.json próprio. */
let useProfile = false;

class SmokeError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SmokeError(msg);
}

function log(msg: string): void {
  console.log(`[bot-smoke] ${msg}`);
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

async function isUp(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(providersFile?: string): Promise<{ base: string; child: ChildProcess | null; dataDir: string | null }> {
  const wanted = process.env.SMOKE_URL;
  // Com provedor real o servidor é sempre nosso: é o `providers.json` temporário que traz o
  // provedor e o perfil com limites. Num servidor de fora não teríamos como impô-los.
  if (wanted && !providersFile && (await isUp(wanted))) {
    log(`usando servidor já no ar em ${wanted}`);
    return { base: wanted, child: null, dataDir: null };
  }
  if (wanted && providersFile) log("SMOKE_URL ignorado: provedor real exige o servidor do smoke (perfil com limites).");
  const port = Number(process.env.SMOKE_PORT ?? 3941);
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-xadrez-botsmoke-"));
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  assert(fs.existsSync(tsxCli), `tsx não encontrado em ${tsxCli} (rode npm install)`);
  log(`subindo servidor em ${base} (DATA_DIR=${dataDir}${IS_FAKE ? ", BOT_FAKE_PROVIDER=1" : ""})`);
  const child = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "src", "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      BOT_AUTORESUME: "false",
      ...(providersFile ? { PROVIDERS_FILE: providersFile } : {}),
      ...(IS_FAKE ? { BOT_FAKE_PROVIDER: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`  [server] ${b.toString()}`));
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`  [server] ${b.toString()}`));
  for (let i = 0; i < 100; i++) {
    if (await isUp(base)) return { base, child, dataDir };
    await sleep(200);
  }
  child.kill();
  throw new SmokeError(`servidor não subiu em ${base}`);
}

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(base: string, method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}/api${route}`, {
    method,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (json as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new SmokeError(`${method} /api${route} → ${res.status}: ${message}`);
  }
  return json;
}

const getState = (base: string): Promise<GameState> => api(base, "GET", "/state") as Promise<GameState>;

async function until(base: string, check: (s: GameState) => boolean, label: string, timeoutMs = 60_000): Promise<GameState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getState(base);
    if (check(state)) return state;
    if (Date.now() > deadline) throw new SmokeError(`timeout esperando: ${label}`);
    await sleep(120);
  }
}

/* ------------------------------------------------------------------ */
/* Preflight: o ambiente tem esse provedor? (docs/09, fase F)          */
/* ------------------------------------------------------------------ */

type Preflight = { ok: true; providersFile?: string } | { ok: false; reason: string };

/** Modelos sugeridos quando o usuário não passa `--model` num provedor pago. */
const PAID_DEFAULT_MODEL: Record<string, string> = {
  // Haiku 4.5 é o mais barato com tool calling: 4 lances ficam muito abaixo de US$ 0,05.
  anthropic: "claude-haiku-4-5",
  openrouter: "openai/gpt-5-mini",
};

async function fetchIds(url: string, headers: Record<string, string> = {}): Promise<string[] | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
    const list = json.data ?? json.models ?? [];
    return list
      .map((m) => (typeof m.id === "string" ? m.id : typeof (m as { name?: unknown }).name === "string" ? ((m as { name: string }).name) : ""))
      .filter((id): id is string => !!id);
  } catch {
    return null;
  }
}

/** `providers.json` temporário: o preset do provedor + um perfil com limites apertados. */
function writeProvidersFile(dir: string): string {
  const preset = PRESETS[PROVIDER];
  const profile: BotProfile = {
    id: SMOKE_PROFILE_ID,
    name: `Smoke ${PROVIDER}`,
    providerId: PROVIDER,
    model: MODEL,
    role: "opponent",
    level: "beginner",
    historyTurns: 2,
    limits: { maxUsdPerGame: 0.05, maxTokensPerGame: 120_000, maxIterationsPerTurn: 4 },
  };
  const file = path.join(dir, "providers.json");
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, providers: [preset], profiles: [profile] }, null, 2)}\n`, "utf8");
  useProfile = true;
  return file;
}

async function preflight(): Promise<Preflight> {
  if (IS_FAKE) return { ok: true };
  const preset = PRESETS[PROVIDER];
  if (!preset) {
    return { ok: false, reason: `"${PROVIDER}" não é um preset conhecido (${Object.keys(PRESETS).join(", ")})` };
  }

  if (preset.local) {
    const url = `${(preset.baseUrl ?? "").replace(/\/+$/, "")}/models`;
    const ids = await fetchIds(url);
    if (!ids) return { ok: false, reason: `nada respondeu em GET ${url} — suba o servidor local e carregue um modelo` };
    if (!MODEL) {
      if (!ids.length) return { ok: false, reason: `${PROVIDER} respondeu, mas não há modelo carregado` };
      MODEL = ids[0];
      log(`modelo escolhido automaticamente: ${MODEL}`);
    } else if (ids.length && !ids.includes(MODEL)) {
      return { ok: false, reason: `o modelo "${MODEL}" não está carregado em ${PROVIDER} (há: ${ids.slice(0, 6).join(", ")})` };
    }
  } else {
    const envName = preset.apiKeyEnv ?? "";
    const key = (envName ? process.env[envName] : "")?.trim();
    if (!key) return { ok: false, reason: `${envName || "a chave do provedor"} não está definida no ambiente/.env` };
    if (!MODEL) MODEL = PAID_DEFAULT_MODEL[PROVIDER] ?? "";
    if (!MODEL) return { ok: false, reason: `informe --model para o provedor "${PROVIDER}"` };
    // `ANTHROPIC_BASE_URL` é o que o próprio SDK respeita (proxy/gateway compatível).
    const anthropicBase = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const ids =
      PROVIDER === "anthropic"
        ? await fetchIds(`${anthropicBase}/v1/models?limit=100`, { "x-api-key": key, "anthropic-version": "2023-06-01" })
        : await fetchIds(`${preset.baseUrl}/models?supported_parameters=tools`, { Authorization: `Bearer ${key}` });
    if (!ids) return { ok: false, reason: `a API de ${PROVIDER} não respondeu à listagem de modelos (chave inválida ou sem rede?)` };
    if (ids.length && !ids.includes(MODEL)) {
      return { ok: false, reason: `o modelo "${MODEL}" não está disponível em ${PROVIDER}; passe --model <id>` };
    }
    log(`provedor pago "${PROVIDER}": limite de US$ 0,05 e 4 lances nesta partida`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-xadrez-botsmoke-cfg-"));
  return { ok: true, providersFile: writeProvidersFile(dir) };
}

/* ------------------------------------------------------------------ */
/* Cenários                                                            */
/* ------------------------------------------------------------------ */

function botSeat(name: string): Record<string, unknown> {
  if (useProfile) return { kind: "bot", profileId: SMOKE_PROFILE_ID, name };
  return { kind: "bot", providerId: PROVIDER, model: MODEL, name };
}

async function scenarioHumanVsBot(base: string): Promise<void> {
  log("cenário 1: humano (brancas) vs bot (pretas)");
  const created = (await api(base, "POST", "/game", {
    seats: { white: { kind: "human", name: "Smoke" }, black: botSeat("Bot Smoke") },
  })) as GameState;
  assert(created.seats.black.kind === "bot", "assento das pretas deveria ser bot");
  assert(created.seats.black.bot?.providerId === PROVIDER, "providerId do assento errado");

  for (let i = 1; i <= 4; i++) {
    const before = await getState(base);
    if (before.status === "finished") break;
    const move = before.legalMoves[0].san;
    await api(base, "POST", "/move", { move });
    const after = await until(base, (s) => s.ply >= i * 2 || s.status === "finished", `resposta do bot ao lance ${i}`);
    if (after.status === "finished") break;
    const last = after.history[after.history.length - 1];
    assert(last.by === "bot", `lance ${after.ply} deveria ser do bot`);
    log(`  ${i}. ${move} ${last.san}${last.comment ? ` — "${last.comment.slice(0, 60)}"` : ""}`);
  }

  const state = await getState(base);
  assert(state.history.filter((m) => m.by === "bot").length >= 4, "o bot deveria ter jogado 4 lances");
  const usage = state.seats.black.bot?.usage;
  assert(usage && usage.calls >= 4, "usage.calls do bot não foi contabilizado");
  log(`  uso: ${usage?.calls} chamadas, ${usage?.inputTokens}+${usage?.outputTokens} tokens, ${usage?.illegalMoves} ilegais`);
}

async function scenarioMessage(base: string): Promise<void> {
  log("cenário 2: mensagem do humano vira comentário do bot");
  const before = (await getState(base)).commentary.length;
  await api(base, "POST", "/message", { text: "Por que esse lance? Explique em uma frase.", to: "black" });
  const state = await until(
    base,
    (s) => s.commentary.length > before && s.commentary.slice(before).some((c) => c.author === "black"),
    "comentário de resposta do bot",
  );
  const answer = state.commentary.filter((c) => c.author === "black").pop();
  log(`  resposta: "${(answer?.text ?? "").slice(0, 80)}"`);
}

async function scenarioStopResume(base: string): Promise<void> {
  log("cenário 3: stop e resume do bot");
  await api(base, "POST", "/bots/black/stop");
  const stopped = await getState(base);
  assert(stopped.seats.black.bot?.status === "stopped", `status esperado stopped, veio ${stopped.seats.black.bot?.status}`);

  const plyBefore = stopped.ply;
  if (stopped.turn === "white" && stopped.status === "active") {
    await api(base, "POST", "/move", { move: stopped.legalMoves[0].san });
    await sleep(600);
    const idle = await getState(base);
    assert(idle.ply === plyBefore + 1, "bot parado não deveria ter jogado");
  }
  await api(base, "POST", "/bots/black/resume");
  await until(base, (s) => s.seats.black.bot?.status !== "stopped", "bot retomado");
  log("  bot parou e voltou sem perder o assento");
}

async function scenarioBotVsBot(base: string): Promise<void> {
  log("cenário 4: bot vs bot");
  await api(base, "POST", "/game", {
    seats: { white: botSeat("Bot Brancas"), black: botSeat("Bot Pretas") },
  });
  const state = await until(base, (s) => s.ply >= 6 || s.status === "finished", "6 meios-lances de bot vs bot", 120_000);
  assert(state.history.every((m) => m.by === "bot"), "todos os lances deveriam ser de bots");
  log(`  ${state.history.map((m) => m.san).join(" ")}`);
  await api(base, "POST", "/bots/white/stop");
  await api(base, "POST", "/bots/black/stop");
}

async function checkProvider(base: string): Promise<boolean> {
  const { providers } = (await api(base, "GET", "/providers")) as { providers: ProviderPublic[] };
  const found = providers.find((p) => p.id === PROVIDER);
  if (!found) {
    console.log(`SKIP: provedor "${PROVIDER}" não está configurado (veja providers.json).`);
    return false;
  }
  if (!MODEL) {
    console.log(`SKIP: informe --model <modelo> para o provedor "${PROVIDER}".`);
    return false;
  }
  if (IS_FAKE) return true;
  const test = (await api(base, "POST", `/providers/${PROVIDER}/test`).catch(() => ({ ok: false }))) as { ok?: boolean };
  if (!test.ok) {
    console.log(`SKIP: provedor "${PROVIDER}" não respondeu ao teste de conexão.`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const env = await preflight();
  if (!env.ok) {
    console.log(`SKIP: ${env.reason}.`);
    return;
  }
  log(`provedor: ${PROVIDER}${MODEL ? ` · modelo: ${MODEL}` : ""}`);
  const { base, child, dataDir } = await ensureServer(env.providersFile);
  let ok = false;
  try {
    if (!(await checkProvider(base))) {
      ok = true;
      return;
    }
    await scenarioHumanVsBot(base);
    await scenarioMessage(base);
    if (IS_FAKE) {
      // Provedor real: paramos nos 2 primeiros cenários (custo e tempo de um modelo real).
      await scenarioStopResume(base);
      await scenarioBotVsBot(base);
    }
    ok = true;
    console.log("\nOK");
  } finally {
    if (child) {
      child.kill();
      await sleep(400);
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
    if (env.providersFile) fs.rmSync(path.dirname(env.providersFile), { recursive: true, force: true });
    if (!ok) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\nFALHOU: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
