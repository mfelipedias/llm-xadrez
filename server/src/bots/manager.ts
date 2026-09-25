/**
 * BotManager: um `BotPlayer` por cor (docs/09, seções 3.5 e 5.2).
 *
 * É ele quem sabe o que é um provedor de LLM: resolve perfil/provedor/modelo, cria e para
 * bots, responde ao `POST /api/game` com `seats` (via `BotSeatingHook`) e às rotas
 * `/api/bots/*`. O `GameStore` só recebe `SeatInit { kind: "bot", sessionId, bot }`.
 */
import type { BotRole, BotSeatInfo, Color, GameState, SeatRequest, StudentLevel, ThinkingMode, ToolMode } from "../../../shared/types.js";
import type { GameStore, SeatInit } from "../game/store.js";
import type { Lang } from "../game/format.js";
import { createLogger } from "../log.js";
import { BotPlayer, type BotPlayerConfig, type BotPlayerDeps, type MoveFailurePolicy } from "./player.js";
import type { ProviderRegistry } from "./providers/registry.js";

const log = createLogger("bot");

const COLORS: Color[] = ["white", "black"];

export type BotSeatRequest = Extract<SeatRequest, { kind: "bot" }>;

/** Pedido inválido/recusado: a API transforma em 4xx com esta mensagem. */
export class BotSeatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BotSeatError";
  }
}

export interface BotManagerDeps {
  store: GameStore;
  registry: ProviderRegistry;
  lang?: Lang;
  language?: string;
  /** Ajustes do loop (testes usam timeouts curtos). */
  player?: Partial<Omit<BotPlayerDeps, "store" | "provider" | "onExit">>;
}

interface ResolvedBot {
  providerId: string;
  model: string;
  profileId?: string;
  name: string;
  role: BotRole;
  level: StudentLevel;
  temperature?: number;
  toolMode: ToolMode;
  thinking: ThinkingMode;
  historyTurns: number;
  limits?: BotPlayerConfig["limits"];
  paid: boolean;
  local: boolean;
}

export class BotManager {
  private readonly store: GameStore;
  private readonly registry: ProviderRegistry;
  private readonly deps: BotManagerDeps;
  private readonly players = new Map<Color, BotPlayer>();

  constructor(deps: BotManagerDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.registry = deps.registry;
  }

  /* ---------------------------- resolução ----------------------------- */

  private failurePolicy(): { vsHuman?: MoveFailurePolicy; vsBot?: MoveFailurePolicy } {
    const defaults = this.registry.defaults()?.onMoveFailure;
    const out: { vsHuman?: MoveFailurePolicy; vsBot?: MoveFailurePolicy } = {};
    if (defaults?.vsHuman) out.vsHuman = defaults.vsHuman;
    if (defaults?.vsBot) out.vsBot = defaults.vsBot;
    return out;
  }

  /** Traduz `SeatRequest`/`seat.bot` em configuração completa, validando provedor e chave. */
  private resolve(req: BotSeatRequest): ResolvedBot {
    const profile = req.profileId ? this.registry.profile(req.profileId) : undefined;
    if (req.profileId && !profile) throw new BotSeatError(400, `Perfil de bot "${req.profileId}" não existe.`);

    const providerId = req.providerId ?? profile?.providerId ?? "";
    const model = req.model ?? profile?.model ?? "";
    if (!providerId || !model) throw new BotSeatError(400, "Assento de bot exige `profileId` ou `providerId` + `model`.");
    if (!this.registry.has(providerId)) throw new BotSeatError(400, `Provedor "${providerId}" não está configurado.`);
    const missing = this.registry.missingKeyReason(providerId);
    if (missing) throw new BotSeatError(400, missing);

    const cfg = this.registry.get(providerId);
    const pub = cfg ? this.registry.toPublic(cfg) : undefined;
    const resolved: ResolvedBot = {
      providerId,
      model,
      name: req.name?.trim() || profile?.name || `${providerId}/${model}`,
      role: req.role ?? profile?.role ?? "teacher",
      level: req.level ?? profile?.level ?? "beginner",
      toolMode: profile?.toolMode ?? cfg?.toolMode ?? "native",
      thinking: (req.thinking ?? profile?.thinking) === "off" ? "off" : "default",
      historyTurns: profile?.historyTurns ?? 4,
      paid: pub?.paid ?? false,
      local: pub?.local ?? false,
    };
    if (req.profileId) resolved.profileId = req.profileId;
    if (profile?.temperature !== undefined) resolved.temperature = profile.temperature;
    if (profile?.limits) resolved.limits = profile.limits;
    return resolved;
  }

  private create(color: Color, resolved: ResolvedBot): BotPlayer {
    const provider = this.registry.provider(resolved.providerId);
    const cfg: BotPlayerConfig = {
      color,
      name: resolved.name,
      providerId: resolved.providerId,
      model: resolved.model,
      role: resolved.role,
      level: resolved.level,
      toolMode: resolved.toolMode,
      historyTurns: resolved.historyTurns,
      thinking: resolved.thinking,
      paid: resolved.paid,
      local: resolved.local,
      onMoveFailure: this.failurePolicy(),
      ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.limits ? { limits: resolved.limits } : {}),
      ...(this.deps.language ? { language: this.deps.language } : {}),
    };
    const deps: BotPlayerDeps = {
      store: this.store,
      provider,
      ...(this.deps.lang ? { lang: this.deps.lang } : {}),
      ...(this.deps.player ?? {}),
      onExit: (player, reason) => this.onPlayerExit(player, reason),
    };
    const player = new BotPlayer(cfg, deps);
    log.info(`bot ${resolved.name} (${resolved.providerId}/${resolved.model}) preparado para as ${color === "white" ? "brancas" : "pretas"}`);
    return player;
  }

  private onPlayerExit(player: BotPlayer, reason: string): void {
    for (const color of COLORS) {
      if (this.players.get(color) !== player) continue;
      if (reason === "not_seated") {
        this.players.delete(color);
        log.info(`bot ${player.name} perdeu o assento das ${color === "white" ? "brancas" : "pretas"} (${reason})`);
      }
    }
  }

  /* ------------------------- BotSeatingHook --------------------------- */

  /** Chamado por `POST /api/game` ao montar os assentos da nova partida. */
  prepare(color: Color, req: BotSeatRequest): SeatInit {
    const resolved = this.resolve(req);
    const existing = this.players.get(color);
    if (existing && existing.matches(resolved.providerId, resolved.model, resolved.profileId, resolved.thinking)) {
      // Mesmo perfil: o bot continua sentado e recebe o evento `new_game`.
      return existing.seatInit();
    }
    if (existing) existing.stop();
    const player = this.create(color, resolved);
    this.players.set(color, player);
    return player.seatInit();
  }

  /** Chamado depois de `store.newGame`: liga os loops dos bots que ficaram sentados. */
  afterNewGame(state: GameState): void {
    for (const color of COLORS) {
      const player = this.players.get(color);
      if (!player) continue;
      const seat = state.seats[color];
      if (seat.kind !== "bot" || seat.sessionId !== player.sessionId) {
        player.stop();
        this.players.delete(color);
        continue;
      }
      player.start();
    }
  }

  /* ----------------------------- controle ----------------------------- */

  get(color: Color): BotPlayer | undefined {
    return this.players.get(color);
  }

  /** Senta um bot num assento livre da partida atual (equivalente a `join_game`). */
  sit(color: Color, req: BotSeatRequest): GameState {
    const seat = this.store.getState().seats[color];
    if (seat.kind === "human") {
      throw new BotSeatError(409, `O assento das ${color === "white" ? "brancas" : "pretas"} é do humano (${seat.name}).`);
    }
    if (seat.kind === "mcp" && this.store.isSessionOpen(seat.sessionId)) {
      throw new BotSeatError(409, `O assento das ${color === "white" ? "brancas" : "pretas"} está ocupado por uma sessão MCP ativa (${seat.name}).`);
    }
    const resolved = this.resolve(req);
    const previous = this.players.get(color);
    if (previous) previous.stop();
    const player = this.create(color, resolved);
    this.players.set(color, player);
    this.store.seat(color, player.seatInit());
    player.start();
    return this.store.getState();
  }

  stop(color: Color): BotSeatInfo | null {
    const player = this.requirePlayer(color);
    player.stop();
    return player.botInfo;
  }

  /** Retoma um bot parado/em erro. Com `profileId`/`model`, troca o modelo. */
  resume(color: Color, req?: Partial<BotSeatRequest>): BotSeatInfo {
    const seat = this.store.getState().seats[color];
    if (seat.kind !== "bot") throw new BotSeatError(409, "Esse assento não é de um bot.");
    const wantsSwap = !!(req && (req.profileId || req.providerId || req.model || req.thinking));
    const player = this.players.get(color);
    if (!player || wantsSwap) {
      const base: BotSeatRequest = {
        kind: "bot",
        ...(req?.profileId ? { profileId: req.profileId } : seat.bot?.profileId ? { profileId: seat.bot.profileId } : {}),
        ...(req?.providerId ? { providerId: req.providerId } : !req?.profileId && seat.bot ? { providerId: seat.bot.providerId } : {}),
        ...(req?.model ? { model: req.model } : !req?.profileId && seat.bot ? { model: seat.bot.model } : {}),
        ...(req?.name ? { name: req.name } : { name: seat.name }),
        ...(req?.role ? { role: req.role } : {}),
        ...(req?.level ? { level: req.level } : {}),
        ...(req?.thinking ? { thinking: req.thinking } : seat.bot?.thinking ? { thinking: seat.bot.thinking } : {}),
      };
      this.sit(color, base);
      return this.players.get(color)?.botInfo ?? (this.store.getState().seats[color].bot as BotSeatInfo);
    }
    player.resume({ resetBudget: seat.bot?.status === "budget_exceeded" });
    return player.botInfo;
  }

  /** Libera o assento (`empty`, mantendo o nome), como `leave_game`. */
  leave(color: Color): GameState {
    const player = this.players.get(color);
    if (player) {
      player.stop();
      this.players.delete(color);
    }
    return this.store.unseat(color);
  }

  stopAll(): void {
    for (const [color, player] of this.players) {
      player.stop();
      log.info(`bot das ${color === "white" ? "brancas" : "pretas"} parado (shutdown)`);
    }
    this.players.clear();
  }

  /**
   * `BOT_AUTORESUME`: recria os bots do `current-game.json` depois do `loadState`.
   * Provedor sumiu da config (ou ficou sem chave) → o assento vira `empty` mantendo o nome.
   */
  autoResume(): void {
    for (const color of COLORS) {
      const seat = this.store.getState().seats[color];
      if (seat.kind !== "bot" || !seat.bot) continue;
      const req: BotSeatRequest = {
        kind: "bot",
        providerId: seat.bot.providerId,
        model: seat.bot.model,
        name: seat.name,
        ...(seat.bot.profileId ? { profileId: seat.bot.profileId } : {}),
        ...(seat.bot.thinking ? { thinking: seat.bot.thinking } : {}),
      };
      try {
        const resolved = this.resolve(req);
        const player = this.create(color, resolved);
        this.players.set(color, player);
        this.store.seat(color, player.seatInit());
        player.start();
        log.info(`bot ${resolved.name} retomado nas ${color === "white" ? "brancas" : "pretas"} (BOT_AUTORESUME)`);
      } catch (err) {
        log.warn(`não foi possível retomar o bot das ${color === "white" ? "brancas" : "pretas"}: ${(err as Error).message}`);
        this.store.unseat(color);
      }
    }
  }

  private requirePlayer(color: Color): BotPlayer {
    const player = this.players.get(color);
    if (!player) throw new BotSeatError(404, `Não há bot no assento das ${color === "white" ? "brancas" : "pretas"}.`);
    return player;
  }
}
