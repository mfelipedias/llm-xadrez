/**
 * BotPlayer: o servidor operando um assento sozinho (docs/09, seções 1 e 3).
 *
 * Registra uma **sessão sintética** (`bot:<cor>:<hex>`), senta como `kind: "bot"` e roda um
 * loop agentic: espera o evento em `store.waitForTurn` (sem tool `wait_for_turn`, sem cap de
 * 120 s), monta a conversa com o mesmo texto que uma sessão MCP receberia
 * (`formatTurnEvent`), chama o provedor e executa as tools **direto** em `mcp/tools.ts`.
 *
 * O GameStore não sabe o que é um provedor de LLM: para ele o bot é só um ocupante com
 * `sessionId`, igual a uma sessão MCP.
 */
import type {
  BotLimits,
  BotRole,
  BotSeatInfo,
  Color,
  StudentLevel,
  ToolMode,
  TurnEvent,
} from "../../../shared/types.js";
import { botSessionId, type GameStore, type SeatInit } from "../game/store.js";
import { formatTurnEvent, type Lang } from "../game/format.js";
import { otherColor } from "../game/rules.js";
import type { ToolContext } from "../mcp/tools.js";
import { createLogger } from "../log.js";
import { Budget } from "./budget.js";
import { buildSystemPrompt, turnInstruction, type RoundMode } from "./prompt.js";
import { parseBotText, textModeInstructions, textModeTurnInstruction } from "./textmode.js";
import { MOVE_TOOLS, TALK_TOOLS, dispatchBotTool, toolSpecs, type BotToolName } from "./toolset.js";
import { ProviderError, type ChatMessage, type ChatProvider, type ChatResult, type ToolSpec } from "./providers/types.js";

const log = createLogger("bot");

export type MoveFailurePolicy = "pause" | "random_legal";

export interface BotPlayerConfig {
  color: Color;
  /** Nome exibido no assento e no PGN. */
  name: string;
  providerId: string;
  model: string;
  profileId?: string;
  role: BotRole;
  level: StudentLevel;
  temperature?: number;
  /** "auto" resolve na 1ª rodada (docs/09, seção 2.2). */
  toolMode: ToolMode;
  /** Rodadas de conversa mantidas no prompt (docs/09, seção 3.3). Default: 4. */
  historyTurns?: number;
  limits?: BotLimits;
  /** Política de falha por tipo de oponente. Default: `pause` vs humano, `random_legal` vs bot. */
  onMoveFailure?: { vsHuman?: MoveFailurePolicy; vsBot?: MoveFailurePolicy };
  /** Provedor pago: só aí o limite em dólares vale. */
  paid?: boolean;
  /** Provedor local (CPU lenta): timeout de rodada maior. */
  local?: boolean;
  language?: string;
  maxTokens?: number;
}

export interface BotPlayerDeps {
  store: GameStore;
  provider: ChatProvider;
  lang?: Lang;
  now?: () => number;
  /** Ciclo do `waitForTurn` interno (só repete quando estoura). Default: 30 s. */
  waitTimeoutMs?: number;
  /** Tempo máximo de uma rodada inteira. Default: 120 s (300 s em provedor local). */
  turnTimeoutMs?: number;
  /** Tentativas extras por chamada em erro retryable (429/5xx/rede). Default: 4. */
  maxRetriesPerCall?: number;
  /** Lances ilegais tolerados numa rodada antes do fallback. Default: 3. */
  maxIllegalPerTurn?: number;
  /** Tentativas de lance (ilegais + respostas ilegíveis) por rodada. Default: 3. */
  maxMoveAttempts?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** Corta partidas infinitas de bot vs bot. Default: 300 meios-lances. */
  maxPliesPerGame?: number;
  /** Chamado quando o loop termina sozinho (assento perdido, erro fatal, orçamento). */
  onExit?: (player: BotPlayer, reason: string) => void;
}

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_TURN_MS = 120_000;
const DEFAULT_LOCAL_TURN_MS = 300_000;
const MAX_COMMENT_CHARS = 4000;

/** Cede o event loop (macrotask) entre rodadas/iterações do bot. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function providerText(err: unknown): string {
  if (err instanceof ProviderError) return err.shortText;
  return err instanceof Error ? err.message : String(err);
}

export class BotPlayer {
  readonly sessionId: string;
  private readonly store: GameStore;
  private readonly provider: ChatProvider;
  private readonly deps: BotPlayerDeps;
  private readonly cfg: BotPlayerConfig;
  private readonly lang: Lang | undefined;
  private readonly now: () => number;
  private readonly budget: Budget;

  private color: Color;
  private info: BotSeatInfo;
  private rounds: ChatMessage[][] = [];
  private promptCache: { key: string; text: string } | null = null;

  private activeToolMode: "native" | "text";
  private autoResolved: boolean;
  private resultCommented = false;

  private cancelled = true;
  private paused = false;
  private looping = false;
  private stopController = new AbortController();
  private turnController: AbortController | null = null;

  constructor(cfg: BotPlayerConfig, deps: BotPlayerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.store = deps.store;
    this.provider = deps.provider;
    this.lang = deps.lang;
    this.now = deps.now ?? (() => Date.now());
    this.color = cfg.color;
    this.sessionId = botSessionId(cfg.color);
    this.budget = new Budget({ ...(cfg.limits ? { limits: cfg.limits } : {}), paid: cfg.paid ?? false });
    this.activeToolMode = cfg.toolMode === "text" ? "text" : "native";
    this.autoResolved = cfg.toolMode !== "auto";
    this.info = {
      providerId: cfg.providerId,
      model: cfg.model,
      toolMode: this.activeToolMode,
      status: "idle",
      usage: this.budget.usage,
      ...(cfg.profileId ? { profileId: cfg.profileId } : {}),
    };
  }

  /* ------------------------------ acessores --------------------------- */

  get name(): string {
    return this.cfg.name;
  }

  get seatColor(): Color {
    return this.color;
  }

  get running(): boolean {
    return this.looping && !this.cancelled;
  }

  get botInfo(): BotSeatInfo {
    return { ...this.info, usage: { ...this.info.usage } };
  }

  /** Assento para `store.newGame`/`store.seat`. */
  seatInit(): SeatInit {
    return { kind: "bot", name: this.cfg.name, sessionId: this.sessionId, bot: this.botInfo };
  }

  /** Mesmo provedor/modelo/perfil? (para reaproveitar o bot numa nova partida). */
  matches(providerId: string, model: string, profileId?: string): boolean {
    return this.cfg.providerId === providerId && this.cfg.model === model && (this.cfg.profileId ?? "") === (profileId ?? "");
  }

  /* ---------------------------- ciclo de vida ------------------------- */

  start(): void {
    if (this.looping) return;
    this.cancelled = false;
    this.paused = false;
    this.stopController = new AbortController();
    this.store.sessionOpened(this.sessionId);
    this.looping = true;
    void this.loop();
  }

  /** Aborta a rodada em curso (nenhum tool tardio é executado) e larga o assento do loop. */
  stop(statusText?: string): void {
    if (this.cancelled && !this.looping) {
      this.setStatus("stopped", statusText);
      return;
    }
    this.cancelled = true;
    this.stopController.abort();
    this.turnController?.abort();
    this.store.sessionClosed(this.sessionId);
    this.setStatus("stopped", statusText);
  }

  /** Volta a jogar depois de `stop`, `error` ou `budget_exceeded`. */
  resume(opts: { resetBudget?: boolean } = {}): void {
    if (opts.resetBudget) this.budget.reset();
    this.paused = false;
    this.setStatus("waiting");
    this.start();
  }

  /** Zera a conversa e o orçamento (nova partida). */
  resetConversation(): void {
    this.rounds = [];
    this.promptCache = null;
    this.resultCommented = false;
    this.budget.reset();
    this.autoResolved = this.cfg.toolMode !== "auto";
    this.activeToolMode = this.cfg.toolMode === "text" ? "text" : "native";
    this.setStatus("waiting");
  }

  /* ------------------------------- estado ----------------------------- */

  private setStatus(status: BotSeatInfo["status"], statusText?: string): void {
    const sameText = (this.info.statusText ?? "") === (statusText ?? "");
    if (this.info.status === status && sameText && status !== "thinking") {
      // Só o uso pode ter mudado: atualiza sem barulho se houver diferença.
      if (JSON.stringify(this.info.usage) === JSON.stringify(this.budget.usage)) return;
    }
    const patch: Partial<BotSeatInfo> = {
      status,
      usage: this.budget.usage,
      statusText: undefined,
      thinkingSince: undefined,
      toolMode: this.activeToolMode,
    };
    if (statusText) patch.statusText = statusText;
    if (status === "thinking") patch.thinkingSince = new Date(this.now()).toISOString();
    const applied = this.store.updateBot(this.color, patch);
    this.info = applied ?? { ...this.info, ...patch, usage: this.budget.usage };
    if (!applied) {
      if (!statusText) delete this.info.statusText;
      if (status !== "thinking") delete this.info.thinkingSince;
    }
  }

  private ctx(signal: AbortSignal): ToolContext {
    const ctx: ToolContext = { store: this.store, session: { id: this.sessionId }, signal };
    if (this.lang) ctx.lang = this.lang;
    return ctx;
  }

  private systemPrompt(): string {
    const state = this.store.getState();
    const opponent = state.seats[this.color === "white" ? "black" : "white"];
    const key = `${this.color}|${opponent.kind}|${opponent.name}|${this.activeToolMode}`;
    if (this.promptCache?.key === key) return this.promptCache.text;
    let text = buildSystemPrompt({
      role: this.cfg.role,
      level: this.cfg.level,
      color: this.color,
      myName: this.cfg.name,
      opponentName: opponent.name || "oponente",
      opponentKind: opponent.kind,
      toolMode: this.activeToolMode,
      ...(this.cfg.language ? { language: this.cfg.language } : {}),
    });
    if (this.activeToolMode === "text") text += `\n\n${textModeInstructions(this.cfg.role)}`;
    this.promptCache = { key, text };
    return text;
  }

  private recentHistory(): ChatMessage[] {
    const keep = this.cfg.historyTurns ?? 4;
    if (keep <= 0) return [];
    return this.rounds.slice(-keep).flat();
  }

  private pushRound(round: ChatMessage[]): void {
    const keep = this.cfg.historyTurns ?? 4;
    if (keep <= 0) {
      this.rounds = [];
      return;
    }
    this.rounds.push(round);
    if (this.rounds.length > keep) this.rounds.splice(0, this.rounds.length - keep);
  }

  private switchToTextMode(): void {
    if (this.activeToolMode === "text") return;
    this.activeToolMode = "text";
    this.promptCache = null;
    log.info(`${this.cfg.providerId}/${this.cfg.model} não devolveu tool_calls: usando o modo texto estruturado`);
    this.setStatus(this.info.status);
  }

  /* -------------------------------- loop ------------------------------ */

  private async loop(): Promise<void> {
    let reason = "stopped";
    try {
      while (!this.cancelled && !this.paused) {
        // Provedor rápido (fake/local em cache) resolve tudo em microtasks: sem este respiro
        // o loop do bot sequestra o event loop e o servidor HTTP para de responder.
        await yieldToEventLoop();
        const color = this.store.seatForSession(this.sessionId);
        if (!color) {
          reason = "not_seated";
          break;
        }
        if (color !== this.color) {
          this.color = color;
          this.promptCache = null;
        }
        this.setStatus("waiting");
        const ev = await this.store.waitForTurn(color, this.deps.waitTimeoutMs ?? DEFAULT_WAIT_MS, {
          sessionId: this.sessionId,
          signal: this.stopController.signal,
        });
        if (this.cancelled) break;

        if (ev.event === "not_seated") {
          reason = "not_seated";
          break;
        }
        if (ev.event === "new_game") {
          this.resetConversation();
          continue;
        }
        if (ev.event === "timeout" || ev.event === "opponent_joined") continue;
        if (ev.event === "game_over") {
          if (!this.resultCommented && this.cfg.role !== "silent") {
            this.resultCommented = true;
            await this.runRound(ev, "result");
          }
          continue;
        }
        if (ev.isYourTurn) {
          if (this.overPlyLimit()) {
            reason = "ply_limit";
            break;
          }
          await this.runRound(ev, "move");
          continue;
        }
        if (ev.event === "message" && this.cfg.role !== "silent") {
          await this.runRound(ev, "reply");
          continue;
        }
      }
    } catch (err) {
      reason = "error";
      log.error(`bot ${this.cfg.name} (${this.color}) falhou: ${(err as Error).message}`);
      this.setStatus("error", (err as Error).message);
    } finally {
      this.looping = false;
      if (!this.cancelled) {
        this.cancelled = true;
        if (reason === "not_seated") this.store.sessionClosed(this.sessionId);
      }
      this.deps.onExit?.(this, reason);
    }
  }

  private overPlyLimit(): boolean {
    const max = this.deps.maxPliesPerGame ?? 300;
    if (max <= 0) return false;
    if (this.store.getState().ply < max) return false;
    this.store.addComment("system", `⚠ Partida interrompida em ${max} meios-lances (limite de segurança de bots).`, "warning");
    this.setStatus("stopped", "limite de lances da partida atingido");
    this.paused = true;
    return true;
  }

  /** Uma rodada com timeout próprio; nunca lança. */
  private async runRound(ev: TurnEvent, mode: RoundMode): Promise<void> {
    const controller = new AbortController();
    this.turnController = controller;
    const timeoutMs = this.deps.turnTimeoutMs ?? (this.cfg.local ? DEFAULT_LOCAL_TURN_MS : DEFAULT_TURN_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onStop = (): void => controller.abort();
    this.stopController.signal.addEventListener("abort", onStop, { once: true });
    try {
      await this.playTurn(ev, mode, controller.signal);
      if (controller.signal.aborted && !this.cancelled && mode === "move" && this.store.isYourTurn(this.color)) {
        this.applyMoveFailure(`tempo esgotado (${Math.round(timeoutMs / 1000)} s)`);
      }
    } catch (err) {
      log.error(`rodada do bot ${this.cfg.name} falhou: ${(err as Error).message}`);
      if (!this.cancelled) this.setStatus("error", (err as Error).message);
      this.paused = true;
    } finally {
      clearTimeout(timer);
      this.stopController.signal.removeEventListener("abort", onStop);
      this.turnController = null;
    }
  }

  private async playTurn(ev: TurnEvent, mode: RoundMode, signal: AbortSignal): Promise<void> {
    const state = this.store.getState();
    const eventText = formatTurnEvent(ev, state, this.color, this.lang ? { lang: this.lang } : {});
    const userMessage = (): ChatMessage => ({
      role: "user",
      content: `${eventText}\n\n${this.activeToolMode === "text" ? textModeTurnInstruction(mode) : turnInstruction(mode, this.cfg.role)}`,
    });
    const round: ChatMessage[] = [userMessage()];
    const allowed: BotToolName[] = mode === "move" ? MOVE_TOOLS : TALK_TOOLS;
    const maxIllegal = this.deps.maxIllegalPerTurn ?? 3;
    const maxAttempts = this.deps.maxMoveAttempts ?? 3;
    const maxIter = this.budget.maxIterationsPerTurn;

    let moved = false;
    let commented = false;
    let illegal = 0;
    let attempts = 0;
    let pendingText = "";
    let failure = "";

    for (let i = 1; i <= maxIter; i++) {
      if (signal.aborted || this.cancelled) return;
      await yieldToEventLoop();
      if (signal.aborted || this.cancelled) return;
      const tools: ToolSpec[] | undefined = this.activeToolMode === "text" ? undefined : toolSpecs(allowed);
      // Última tentativa da rodada: determinística (docs/09, seção 2.4, item 4).
      const temperature = i >= maxIter ? 0 : this.cfg.temperature;
      this.setStatus("thinking");

      let res: ChatResult;
      try {
        res = await this.chat([{ role: "system", content: this.systemPrompt() }, ...this.recentHistory(), ...round], tools, temperature, signal);
      } catch (err) {
        if (signal.aborted || this.cancelled) return;
        if (this.handleProviderError(err)) return;
        failure = providerText(err);
        break;
      }
      if (signal.aborted || this.cancelled) return;
      this.budget.addCall(res.usage);
      this.setStatus("acting");

      if (!this.autoResolved && mode === "move") {
        this.autoResolved = true;
        if (!res.toolCalls.length) this.switchToTextMode();
      }

      if (res.toolCalls.length) {
        round.push({ role: "assistant", content: res.text || null, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          // Rodada abortada (stop/takeback/timeout): nenhum tool tardio é executado.
          if (signal.aborted || this.cancelled) return;
          const out = dispatchBotTool(this.ctx(signal), call.name, call.args, allowed);
          round.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.text, isError: out.isError });
          if (out.moved) moved = true;
          if (out.commented) commented = true;
          if (out.isError && call.name === "make_move") {
            illegal += 1;
            attempts += 1;
            this.budget.addIllegal();
          }
        }
        if (res.text.trim().length > 20) pendingText = res.text.trim();
        if (mode !== "move") {
          // Rodada de conversa: um comentário publicado encerra; senão tenta de novo.
          if (commented) break;
          attempts += 1;
          if (attempts >= maxAttempts) break;
          continue;
        }
        if (moved) break;
        if (illegal >= maxIllegal || attempts >= maxAttempts) {
          failure = `${illegal} lance(s) ilegal(is) seguidos`;
          break;
        }
        continue;
      }

      // Sem tool calls: o texto vira lance (modo texto ou rede de segurança do modo nativo).
      const text = res.text ?? "";
      round.push({ role: "assistant", content: text });
      if (mode !== "move") {
        if (text.trim()) commented = this.publishComment(text, mode === "result" ? "lesson" : "reaction", signal) || commented;
        break;
      }

      const parsed = parseBotText(text, this.store.getState().legalMoves);
      if (parsed.move) {
        const args: Record<string, unknown> = { move: parsed.move };
        if (parsed.comment && this.cfg.role !== "silent") args.comment = parsed.comment.slice(0, 2000);
        const out = dispatchBotTool(this.ctx(signal), "make_move", args, allowed);
        round.push({ role: "user", content: out.text });
        if (out.moved) {
          moved = true;
          if (out.commented) commented = true;
          if (parsed.arrows?.length || parsed.squares?.length) {
            dispatchBotTool(
              this.ctx(signal),
              "highlight",
              { arrows: parsed.arrows ?? [], squares: parsed.squares ?? [] },
              allowed,
            );
          }
          break;
        }
        illegal += 1;
        attempts += 1;
        this.budget.addIllegal();
      } else {
        attempts += 1;
        const hint = parsed.rejected
          ? `O lance "${parsed.rejected}" não existe nesta posição.`
          : "Não consegui encontrar um lance na sua resposta.";
        round.push({
          role: "user",
          content: `${hint} Responda APENAS com "MOVE: <lance>", escolhendo um da lista "Lances legais" da mensagem anterior.`,
        });
      }
      if (illegal >= maxIllegal || attempts >= maxAttempts) {
        failure = parsed.rejected ? `lance inexistente "${parsed.rejected}"` : "resposta sem lance legal";
        break;
      }
    }

    if (signal.aborted || this.cancelled) return;

    // Texto solto do assistant vira comentário de plano quando nenhum comentário foi publicado.
    if (pendingText && !commented && this.cfg.role !== "silent") {
      this.publishComment(pendingText, "plan", signal);
    }
    this.pushRound(round);
    this.store.touchSession(this.sessionId);

    const over = this.budget.exceeded();
    if (over) {
      this.exceedBudget(over);
      return;
    }
    if (mode === "move" && !moved && this.store.isYourTurn(this.color)) {
      this.applyMoveFailure(failure || "o modelo não escolheu um lance legal");
      return;
    }
    this.setStatus("waiting");
  }

  private publishComment(text: string, category: "plan" | "lesson" | "reaction", signal: AbortSignal): boolean {
    const parsed = parseBotText(text, []);
    const body = (parsed.comment ?? text).trim();
    if (!body) return false;
    const out = dispatchBotTool(this.ctx(signal), "comment", { text: body.slice(0, MAX_COMMENT_CHARS), category }, TALK_TOOLS);
    return !out.isError;
  }

  /* ----------------------------- provedor ----------------------------- */

  private async chat(
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    temperature: number | undefined,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const maxRetries = this.deps.maxRetriesPerCall ?? 4;
    const base = this.deps.backoffBaseMs ?? 1000;
    const cap = this.deps.maxBackoffMs ?? 30_000;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.provider.chat({
          model: this.cfg.model,
          messages,
          signal,
          toolChoice: "auto",
          ...(tools?.length ? { tools } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(this.cfg.maxTokens !== undefined ? { maxTokens: this.cfg.maxTokens } : {}),
        });
      } catch (err) {
        lastError = err;
        if (signal.aborted || this.cancelled) throw err;
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable || attempt >= maxRetries) throw err;
        const wait = Math.min(
          cap,
          (err as ProviderError).retryAfterMs ?? Math.round(base * 2 ** attempt * (1 + Math.random() * 0.25)),
        );
        this.setStatus("thinking", `${providerText(err)} — nova tentativa em ${Math.max(1, Math.round(wait / 1000))} s`);
        await this.sleep(wait, signal);
        if (signal.aborted || this.cancelled) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** `true` quando o erro é fatal e o loop deve parar (chave, crédito, modelo). */
  private handleProviderError(err: unknown): boolean {
    const text = providerText(err);
    const status = err instanceof ProviderError ? err.status : undefined;
    if (status === 401 || status === 402 || status === 403 || status === 404) {
      this.store.addComment("system", `⚠ ${this.cfg.name} (${this.cfg.providerId}): ${text}. O bot foi parado.`, "warning");
      this.setStatus("error", text);
      this.paused = true;
      return true;
    }
    log.warn(`${this.cfg.providerId}/${this.cfg.model}: ${text}`);
    return false;
  }

  /* ----------------------------- fallbacks ---------------------------- */

  private exceedBudget(reason: string): void {
    this.store.addComment(
      "system",
      `⚠ ${this.cfg.name} atingiu o orçamento desta partida (${reason}). Aumente o limite e retome para continuar.`,
      "warning",
    );
    this.setStatus("budget_exceeded", reason);
    this.paused = true;
  }

  /** docs/09, seção 2.4, item 5: `pause` (humano vs bot) ou `random_legal` (bot vs bot). */
  private applyMoveFailure(reason: string): void {
    const state = this.store.getState();
    const legal = state.legalMoves;
    const opponent = state.seats[otherColor(this.color)];
    const policy =
      opponent.kind === "human"
        ? (this.cfg.onMoveFailure?.vsHuman ?? "pause")
        : (this.cfg.onMoveFailure?.vsBot ?? "random_legal");
    if (policy === "random_legal" && legal.length) {
      const pick = legal[Math.floor(Math.random() * legal.length)].san;
      try {
        this.store.applyMove(this.color, pick);
        this.store.addComment(
          "system",
          `⚠ ${this.cfg.name} não conseguiu escolher um lance (${reason}); joguei ${pick} automaticamente.`,
          "warning",
        );
        this.setStatus("waiting", `lance automático: ${pick}`);
        return;
      } catch (err) {
        log.warn(`fallback random_legal falhou: ${(err as Error).message}`);
      }
    }
    this.store.addComment(
      "system",
      `⚠ ${this.cfg.name} não conseguiu jogar (${reason}). O assento ficou pausado: use "tentar de novo".`,
      "warning",
    );
    this.setStatus("error", reason);
    this.paused = true;
  }
}
