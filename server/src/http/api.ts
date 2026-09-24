/**
 * API REST usada pelo navegador. Ver docs/03-servidor.md, "API REST".
 * Todas as rotas respondem JSON (exceto os PGNs). Erros de regra: 4xx com `ApiError`.
 */
import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type {
  ApiError,
  BotSeatInfo,
  Color,
  GameState,
  HumanSeating,
  MessageRequest,
  MoveRequest,
  NewGameRequest,
  ProvidersResponse,
  ProviderTestResponse,
  ResignRequest,
  SeatRequest,
  ServerInfo,
  TakebackRequest,
} from "../../../shared/types.js";
import { GameError, emptyBotUsage, type GameStore, type SeatInit } from "../game/store.js";
import type { Persistence } from "../game/persist.js";
import { PRESET_IDS, ProvidersFileError, type ProviderRegistry } from "../bots/providers/registry.js";
import { ProviderError } from "../bots/providers/types.js";
import { PROVIDER_ID_PATTERN, validateProviderUpsert } from "../bots/providers/validate.js";
import { ipInList, isLoopbackIp, isValidIpOrCidr } from "../bots/providers/net.js";
import { createLogger } from "../log.js";

const log = createLogger("api");

/** Bot seat request (variante `kind: "bot"` de SeatRequest). */
export type BotSeatRequest = Extract<SeatRequest, { kind: "bot" }>;

/**
 * Ponte com o BotManager (fase C). Sem ela, um assento `bot` pedido em `POST /api/game` é
 * criado no store com status "stopped" (ninguém joga por ele) — o contrato REST já vale.
 */
export interface BotSeatingHook {
  /** Cria/reaproveita o BotPlayer e devolve o SeatInit a usar na nova partida. */
  prepare(color: Color, req: BotSeatRequest): SeatInit;
  /** Chamado depois que a partida foi criada, com o estado final. */
  afterNewGame?(state: GameState): void;
  /** `POST /api/bots/:color/sit`. */
  sit?(color: Color, req: BotSeatRequest): GameState;
  /** `POST /api/bots/:color/stop`. */
  stop?(color: Color): BotSeatInfo | null;
  /** `POST /api/bots/:color/resume`. */
  resume?(color: Color, req?: Partial<BotSeatRequest>): BotSeatInfo;
  /** `POST /api/bots/:color/leave`. */
  leave?(color: Color): GameState;
}

export interface ApiDeps {
  store: GameStore;
  persistence: Pick<Persistence, "listGames" | "readGamePgn">;
  serverInfo: () => ServerInfo;
  defaultHumanName: string;
  /** Camada de provedores (docs/09, fase B). Ausente = rotas /api/providers* respondem 503. */
  registry?: ProviderRegistry;
  /** BotManager (docs/09, fase C). */
  bots?: BotSeatingHook;
  /**
   * Token das rotas de administração (ADMIN_TOKEN, ou MCP_TOKEN se vazio). Quem manda
   * `Authorization: Bearer <token>` administra de qualquer IP. Loopback e `adminAllowFrom`
   * administram sem token.
   */
  adminToken?: string;
  /** IPs/CIDRs além do loopback que administram sem token (ADMIN_ALLOW_FROM; Docker: a bridge). */
  adminAllowFrom?: string[];
  /** Servidor dentro de um container: muda as dicas do teste de conexão (localhost ≠ host). */
  inDocker?: boolean;
}

const COLORS: Color[] = ["white", "black"];
const SEATINGS: HumanSeating[] = ["white", "black", "both", "none"];

function sendError(res: Response, status: number, error: string, legalMoves?: string[]): void {
  const body: ApiError = { error };
  if (legalMoves) body.legalMoves = legalMoves;
  res.status(status).json(body);
}

function statusForError(err: GameError): number {
  switch (err.code) {
    case "seat_taken":
      return 409;
    case "not_seated":
    case "nothing_to_undo":
    case "invalid_argument":
    case "invalid_fen":
    case "illegal_move":
    case "not_your_turn":
    case "game_not_active":
    case "game_finished":
    default:
      return 400;
  }
}

function isColor(v: unknown): v is Color {
  return v === "white" || v === "black";
}

/** Pedido de assento inválido: vira 4xx com mensagem pronta. */
class SeatRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SeatRequestError";
  }
}

/** Status HTTP carregado pelo erro (SeatRequestError, BotSeatError) ou o fallback. */
function httpStatusOf(err: unknown, fallback = 400): number {
  const raw = (err as { status?: unknown } | null)?.status;
  return typeof raw === "number" && raw >= 400 && raw < 600 ? raw : fallback;
}

/** Comparação de tokens em tempo constante (hash antes, para não vazar o tamanho). */
function tokenEquals(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Quem pode gravar `providers.json` (docs/09, seção 6): o próprio computador (loopback),
 * um IP/CIDR de `allowFrom` (no Docker, a bridge por onde o host chega ao container) ou
 * quem apresentar `Authorization: Bearer <adminToken>`.
 */
export function isAdminRequest(
  ip: string | undefined,
  authorization: string | undefined,
  opts: { adminToken?: string; adminAllowFrom?: readonly string[] },
): boolean {
  if (isLoopbackIp(ip)) return true;
  if (opts.adminAllowFrom?.length && ipInList(ip, opts.adminAllowFrom)) return true;
  if (opts.adminToken) {
    const header = authorization ?? "";
    const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
    if (token && tokenEquals(token, opts.adminToken)) return true;
  }
  return false;
}

/** Cor do assento humano que deve agir (vez, ou o único humano). */
function humanSeatColor(store: GameStore, requested?: unknown): Color | null {
  const state = store.getState();
  if (isColor(requested)) return state.seats[requested].kind === "human" ? requested : null;
  const humans = COLORS.filter((c) => state.seats[c].kind === "human");
  if (humans.length === 0) return null;
  if (humans.length === 1) return humans[0];
  return state.turn;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store } = deps;
  const router = Router();
  const adminAllowFrom = (deps.adminAllowFrom ?? []).map((e) => e.trim()).filter(Boolean);
  const invalidAllow = adminAllowFrom.filter((e) => !isValidIpOrCidr(e));
  if (invalidAllow.length) log.warn(`ADMIN_ALLOW_FROM ignora entradas inválidas: ${invalidAllow.join(", ")}`);

  /** Traduz um `SeatRequest` da UI num `SeatInit` do store. Lança `SeatRequestError`. */
  function seatInitFromRequest(color: Color, req: SeatRequest | undefined, humanName?: string): SeatInit {
    const kind = req?.kind ?? "empty";
    const name = typeof (req as { name?: unknown } | undefined)?.name === "string" ? (req as { name: string }).name : undefined;
    if (kind === "human") {
      return { kind: "human", name: name?.trim() || humanName?.trim() || deps.defaultHumanName };
    }
    if (kind === "mcp") {
      // Sessão MCP viva que já estava nesta cor continua sentada; senão o assento fica vazio
      // esperando `join_game` (é o que "aguardar MCP" significa na UI).
      const previous = store.getState().seats[color];
      if (previous.kind === "mcp" && store.isSessionOpen(previous.sessionId)) {
        const init: SeatInit = { kind: "mcp", name: name?.trim() || previous.name };
        if (previous.sessionId) init.sessionId = previous.sessionId;
        return init;
      }
      return { kind: "empty", name: name?.trim() ?? "" };
    }
    if (kind === "bot") {
      const botReq = req as BotSeatRequest;
      if (deps.bots) return deps.bots.prepare(color, botReq);
      return fallbackBotSeat(botReq, name);
    }
    return { kind: "empty", name: name?.trim() ?? "" };
  }

  /**
   * Sem BotManager (fases A/B): o assento existe e carrega provedor/modelo, mas o bot não joga.
   * A fase C substitui isto pelo `BotSeatingHook`.
   */
  function fallbackBotSeat(req: BotSeatRequest, name?: string): SeatInit {
    const registry = deps.registry;
    const profile = req.profileId && registry ? registry.profile(req.profileId) : undefined;
    if (req.profileId && registry && !profile) {
      throw new SeatRequestError(400, `Perfil de bot "${req.profileId}" não existe.`);
    }
    const providerId = req.providerId ?? profile?.providerId ?? "";
    const model = req.model ?? profile?.model ?? "";
    if (!providerId || !model) {
      throw new SeatRequestError(400, "Assento de bot exige `profileId` ou `providerId` + `model`.");
    }
    if (registry) {
      if (!registry.has(providerId)) throw new SeatRequestError(400, `Provedor "${providerId}" não está configurado.`);
      const missing = registry.missingKeyReason(providerId);
      if (missing) throw new SeatRequestError(400, missing);
    }
    // Mesma precedência do BotManager: perfil > provedor > "native" ("auto" começa nativo).
    const mode = profile?.toolMode ?? registry?.get(providerId)?.toolMode ?? "native";
    const bot: BotSeatInfo = {
      providerId,
      model,
      toolMode: mode === "text" ? "text" : "native",
      status: "stopped",
      statusText: "sem o gerenciador de bots no servidor",
      usage: emptyBotUsage(),
    };
    if (req.profileId) bot.profileId = req.profileId;
    return { kind: "bot", name: name?.trim() || profile?.name || `${providerId}/${model}`, bot };
  }

  router.get("/health", (_req, res) => {
    const info = deps.serverInfo();
    res.json({ ok: true, version: info.version, mcpUrl: info.mcpUrl, mcpSessions: info.mcpSessions });
  });

  router.get("/state", (_req, res) => {
    res.json(store.getState());
  });

  router.post("/game", (req, res) => {
    const body = (req.body ?? {}) as Partial<NewGameRequest>;

    // Novo contrato (docs/09, seção 5.1): `seats` tem precedência sobre `humanSeats`.
    if (body.seats && typeof body.seats === "object") {
      let seats: { white: SeatInit; black: SeatInit };
      try {
        seats = {
          white: seatInitFromRequest("white", body.seats.white, body.humanName),
          black: seatInitFromRequest("black", body.seats.black, body.humanName),
        };
      } catch (err) {
        sendError(res, httpStatusOf(err), (err as Error).message);
        return;
      }
      const startFenExplicit =
        typeof body.startFen === "string" && body.startFen.trim() ? body.startFen.trim() : undefined;
      const kinds = `${seats.white.kind} vs ${seats.black.kind}`;
      log.info(`nova partida via REST (seats: ${kinds}${startFenExplicit ? ", FEN customizado" : ""})`);
      const state = store.newGame({ seats, startFen: startFenExplicit });
      deps.bots?.afterNewGame?.(state);
      res.json(store.getState());
      return;
    }

    const humanSeats: HumanSeating = SEATINGS.includes(body.humanSeats as HumanSeating) ? (body.humanSeats as HumanSeating) : "white";
    const humanName = typeof body.humanName === "string" && body.humanName.trim() ? body.humanName.trim() : deps.defaultHumanName;
    const startFen = typeof body.startFen === "string" && body.startFen.trim() ? body.startFen.trim() : undefined;

    // Assento MCP com sessão ainda aberta continua na nova partida (na cor livre); senão fica `empty`.
    const previous = store.getState();
    const liveMcp = COLORS.map((c) => previous.seats[c])
      .filter((s) => s.kind === "mcp" && store.isSessionOpen(s.sessionId));

    const human: SeatInit = { kind: "human", name: humanName };
    const seats: Record<Color, SeatInit> = { white: { kind: "empty" }, black: { kind: "empty" } };
    if (humanSeats === "both") {
      seats.white = human;
      seats.black = human;
    } else if (humanSeats === "none") {
      const [a, b] = liveMcp;
      if (a) seats[previous.seats.white.sessionId === a.sessionId ? "white" : "black"] = { kind: "mcp", name: a.name, sessionId: a.sessionId };
      if (b) seats[previous.seats.white.sessionId === b.sessionId ? "white" : "black"] = { kind: "mcp", name: b.name, sessionId: b.sessionId };
    } else {
      seats[humanSeats] = human;
      const free: Color = humanSeats === "white" ? "black" : "white";
      const keep = liveMcp[0];
      if (keep) seats[free] = { kind: "mcp", name: keep.name, sessionId: keep.sessionId };
    }
    log.info(`nova partida via REST (humanSeats=${humanSeats}${startFen ? ", FEN customizado" : ""})`);
    const state = store.newGame({ seats: { white: seats.white, black: seats.black }, startFen });
    // Nenhum assento é bot aqui, mas o manager precisa saber para parar bots da partida anterior.
    deps.bots?.afterNewGame?.(state);
    res.json(store.getState());
  });

  router.post("/move", (req, res) => {
    const body = (req.body ?? {}) as Partial<MoveRequest>;
    if (typeof body.move !== "string" || !body.move.trim()) {
      sendError(res, 400, "Informe o lance em `move` (SAN ou UCI).");
      return;
    }
    const state = store.getState();
    if (state.status === "finished") {
      sendError(res, 400, "A partida já terminou.");
      return;
    }
    if (state.status !== "active") {
      sendError(res, 400, "A partida ainda não começou: aguarde a LLM entrar no assento vazio.");
      return;
    }
    const turnSeat = state.seats[state.turn];
    if (turnSeat.kind !== "human") {
      sendError(res, 400, `Não é a vez de um humano: é a vez das ${state.turn === "white" ? "brancas" : "pretas"} (${turnSeat.name}).`);
      return;
    }
    const record = store.applyMove(state.turn, body.move);
    log.info(`humano jogou ${record.san}`);
    res.json(store.getState());
  });

  router.post("/message", (req, res) => {
    const body = (req.body ?? {}) as Partial<MessageRequest>;
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendError(res, 400, "Mensagem vazia.");
      return;
    }
    const to = body.to === "white" || body.to === "black" || body.to === "all" ? body.to : "all";
    store.addHumanMessage(body.text, to);
    res.json(store.getState());
  });

  router.post("/takeback", (req, res) => {
    const body = (req.body ?? {}) as Partial<TakebackRequest>;
    const state = store.getState();
    let plies: number;
    if (typeof body.plies === "number" && Number.isInteger(body.plies) && body.plies > 0) {
      plies = body.plies;
    } else {
      // Default: volta até a posição anterior ao último lance humano.
      let idx = -1;
      for (let i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].by === "human") {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        sendError(res, 400, "Não há lance humano para desfazer.");
        return;
      }
      plies = state.history.length - idx;
    }
    res.json(store.takeback(plies, "human"));
  });

  router.post("/resign", (req, res) => {
    const body = (req.body ?? {}) as Partial<ResignRequest>;
    const color = humanSeatColor(store, body.color);
    if (!color) {
      sendError(res, 400, "Nenhum assento humano para desistir (informe `color` se ocupar os dois).");
      return;
    }
    res.json(store.endGame("resignation", color));
  });

  router.post("/draw", (req, res) => {
    const body = (req.body ?? {}) as { color?: unknown };
    const color = humanSeatColor(store, body.color);
    if (!color) {
      sendError(res, 400, "Nenhum assento humano para oferecer empate.");
      return;
    }
    const { accepted, state } = store.offerDraw(color);
    res.json({ ...state, drawAccepted: accepted });
  });

  router.post("/highlight/clear", (_req, res) => {
    res.json(store.setHighlight("system", null));
  });

  /* ------------------------- provedores de LLM ------------------------ */

  /** Registry ou 503 (camada de provedores desligada). */
  function registryOr503(res: Response): ProviderRegistry | null {
    if (deps.registry) return deps.registry;
    sendError(res, 503, "Camada de provedores indisponível neste servidor.");
    return null;
  }

  const adminOpts = { adminToken: deps.adminToken, adminAllowFrom };

  /** Pode gravar `providers.json`? (sem responder nada) */
  function isAdmin(req: Request): boolean {
    return isAdminRequest(req.ip, req.header("authorization"), adminOpts);
  }

  /** Rotas que gravam `providers.json`: loopback, ADMIN_ALLOW_FROM ou o Bearer do ADMIN_TOKEN. */
  function requireAdmin(req: Request, res: Response): boolean {
    if (isAdmin(req)) return true;
    const tokenAccepted = !!deps.adminToken;
    const error = tokenAccepted
      ? `Configuração de provedores recusada para ${req.ip ?? "este endereço"}: envie o ADMIN_TOKEN (ou MCP_TOKEN) em "Authorization: Bearer <token>", ou inclua este IP/rede em ADMIN_ALLOW_FROM no .env.`
      : `Configuração de provedores só é permitida a partir do próprio computador ou de ADMIN_ALLOW_FROM (pedido veio de ${req.ip ?? "endereço desconhecido"}). Inclua este IP/rede em ADMIN_ALLOW_FROM ou defina ADMIN_TOKEN no .env e reinicie o servidor.`;
    const body: ApiError = { error, code: "admin_forbidden", adminTokenAccepted: tokenAccepted };
    res.status(403).json(body);
    return false;
  }

  /** Erro ao gravar providers.json → 500 com a mensagem pronta; outros → rethrow. */
  function sendWriteError(res: Response, err: unknown): void {
    if (err instanceof ProvidersFileError) {
      sendError(res, 500, err.message);
      return;
    }
    throw err;
  }

  router.get("/providers", (req, res) => {
    const registry = registryOr503(res);
    if (!registry) return;
    const body: ProvidersResponse = {
      providers: registry.publicList(),
      profiles: registry.profiles(),
      presets: PRESET_IDS,
      envKeys: registry.envKeyNames(),
      canAdmin: isAdmin(req),
      adminTokenAccepted: !!deps.adminToken,
    };
    res.json(body);
  });

  router.put("/providers/:id", (req, res) => {
    const registry = registryOr503(res);
    if (!registry) return;
    if (!requireAdmin(req, res)) return;
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      sendError(res, 400, "Informe o id do provedor.");
      return;
    }
    // A UI nunca envia a chave: ela vive só no .env (docs/09, seção 6).
    const checked = validateProviderUpsert(id, req.body ?? {}, registry.get(id));
    if (!checked.ok) {
      sendError(res, 400, checked.error);
      return;
    }
    try {
      const saved = registry.upsert(id, checked.patch);
      if (checked.created) log.info(`provedor "${id}" criado (${saved.kind})`);
      res.json(registry.toPublic(saved));
    } catch (err) {
      sendWriteError(res, err);
    }
  });

  router.post("/providers/preset", (req, res) => {
    const registry = registryOr503(res);
    if (!registry) return;
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as { preset?: unknown; id?: unknown };
    const preset = typeof body.preset === "string" ? body.preset : "";
    if (!preset || !PRESET_IDS.includes(preset)) {
      sendError(res, 400, `Preset desconhecido. Disponíveis: ${PRESET_IDS.join(", ")}.`);
      return;
    }
    // Sem `id`: usa o do preset e, se já existir, `custom-2`, `custom-3`... Com `id`: colisão = 409.
    const explicitId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
    if (explicitId !== undefined && !PROVIDER_ID_PATTERN.test(explicitId)) {
      sendError(res, 400, "Id inválido: use de 1 a 40 caracteres entre a-z, 0-9, \"-\" e \"_\", começando por letra ou número.");
      return;
    }
    if (explicitId !== undefined && registry.has(explicitId)) {
      sendError(res, 409, `Já existe um provedor com id "${explicitId}".`);
      return;
    }
    try {
      const cfg = registry.addPreset(preset, explicitId);
      res.json(registry.toPublic(cfg));
    } catch (err) {
      if (err instanceof ProviderError) sendError(res, 409, err.shortText);
      else sendWriteError(res, err);
    }
  });

  router.delete("/providers/:id", (req, res) => {
    const registry = registryOr503(res);
    if (!registry) return;
    if (!requireAdmin(req, res)) return;
    const id = String(req.params.id ?? "");
    const inUse = COLORS.some((c) => {
      const seat = store.getState().seats[c];
      return seat.kind === "bot" && seat.bot?.providerId === id;
    });
    if (inUse) {
      sendError(res, 409, `O provedor "${id}" está em uso por um bot na partida atual.`);
      return;
    }
    let removed: boolean;
    try {
      removed = registry.remove(id);
    } catch (err) {
      sendWriteError(res, err);
      return;
    }
    if (!removed) {
      sendError(res, 404, `Provedor "${id}" não encontrado.`);
      return;
    }
    res.json({ ok: true });
  });

  router.post("/providers/:id/test", (req, res, next) => {
    const registry = registryOr503(res);
    if (!registry) return;
    const id = String(req.params.id ?? "");
    if (!registry.has(id)) {
      sendError(res, 404, `Provedor "${id}" não encontrado.`);
      return;
    }
    registry
      .test(id, { inDocker: !!deps.inDocker })
      .then((result) => {
        if (result.ok) {
          res.json({ ok: true, latencyMs: result.latencyMs, models: result.models } satisfies ProviderTestResponse);
          return;
        }
        const body: ProviderTestResponse = { ok: false, error: result.error };
        if (result.hint) body.hint = result.hint;
        res.status(502).json(body);
      })
      .catch(next);
  });

  router.get("/providers/:id/models", (req, res, next) => {
    const registry = registryOr503(res);
    if (!registry) return;
    const id = String(req.params.id ?? "");
    if (!registry.has(id)) {
      sendError(res, 404, `Provedor "${id}" não encontrado.`);
      return;
    }
    registry
      .models(id, req.query.refresh === "1")
      .then((models) => res.json(models))
      .catch((err: unknown) => {
        // Mesmo diagnóstico do teste de conexão; `hint` vai junto do ApiError.
        const diag = registry.diagnose(id, err, { inDocker: !!deps.inDocker });
        const body: ApiError & { hint?: string } = { error: diag.error };
        if (diag.hint) body.hint = diag.hint;
        res.status(502).json(body);
      })
      .catch(next);
  });

  /* ------------------------- bots do servidor ------------------------- */

  /** BotManager ou 503 (servidor sem bots internos). */
  function botsOr503(res: Response): BotSeatingHook | null {
    if (deps.bots) return deps.bots;
    sendError(res, 503, "Bots internos indisponíveis neste servidor.");
    return null;
  }

  function colorParam(req: Request, res: Response): Color | null {
    const raw = String(req.params.color ?? "");
    if (isColor(raw)) return raw;
    sendError(res, 400, 'Cor inválida: use "white" ou "black".');
    return null;
  }

  /** Corpo de sit/resume: um `SeatRequest` de bot sem o `kind`. */
  function botRequestBody(req: Request): BotSeatRequest {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pick = (key: string): string | undefined =>
      typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined;
    const out: BotSeatRequest = { kind: "bot" };
    const profileId = pick("profileId");
    const providerId = pick("providerId");
    const model = pick("model");
    const name = pick("name");
    if (profileId) out.profileId = profileId;
    if (providerId) out.providerId = providerId;
    if (model) out.model = model;
    if (name) out.name = name;
    if (body.role === "teacher" || body.role === "opponent" || body.role === "silent") out.role = body.role;
    if (body.level === "beginner" || body.level === "intermediate" || body.level === "advanced") out.level = body.level;
    return out;
  }

  function botRoute(handler: (bots: BotSeatingHook, color: Color, req: Request) => unknown): (req: Request, res: Response) => void {
    return (req, res) => {
      const bots = botsOr503(res);
      if (!bots) return;
      const color = colorParam(req, res);
      if (!color) return;
      try {
        handler(bots, color, req);
      } catch (err) {
        sendError(res, httpStatusOf(err), (err as Error).message);
        return;
      }
      res.json(store.getState());
    };
  }

  router.post(
    "/bots/:color/sit",
    botRoute((bots, color, req) => {
      if (!bots.sit) throw new SeatRequestError(503, "Este servidor não sabe sentar bots.");
      bots.sit(color, botRequestBody(req));
    }),
  );

  router.post(
    "/bots/:color/stop",
    botRoute((bots, color) => {
      if (!bots.stop) throw new SeatRequestError(503, "Este servidor não sabe parar bots.");
      bots.stop(color);
    }),
  );

  router.post(
    "/bots/:color/resume",
    botRoute((bots, color, req) => {
      if (!bots.resume) throw new SeatRequestError(503, "Este servidor não sabe retomar bots.");
      bots.resume(color, botRequestBody(req));
    }),
  );

  router.post(
    "/bots/:color/leave",
    botRoute((bots, color) => {
      if (!bots.leave) throw new SeatRequestError(503, "Este servidor não sabe liberar assentos de bot.");
      bots.leave(color);
    }),
  );

  router.get("/pgn", (_req, res) => {
    const state = store.getState();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="partida-${state.id}.pgn"`);
    res.send(`${state.pgn.trim()}\n`);
  });

  router.get("/games", (_req, res) => {
    res.json(deps.persistence.listGames());
  });

  router.get("/games/:id/pgn", (req, res) => {
    const id = String(req.params.id ?? "");
    const pgn = deps.persistence.readGamePgn(id);
    if (pgn === null) {
      sendError(res, 404, "Partida não encontrada.");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.pgn"`);
    res.send(pgn);
  });

  router.use((_req, res) => {
    sendError(res, 404, "Rota não encontrada.");
  });

  // Tratador de erros: GameError → 4xx com legalMoves; resto → 500.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GameError) {
      sendError(res, statusForError(err), err.message, err.legalMoves);
      return;
    }
    if (err instanceof SeatRequestError) {
      sendError(res, err.status, err.message);
      return;
    }
    if (err instanceof ProviderError) {
      sendError(res, 502, err.shortText);
      return;
    }
    if (err instanceof ProvidersFileError) {
      sendError(res, 500, err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`erro inesperado: ${message}`);
    if (!res.headersSent) sendError(res, 500, "Erro interno do servidor.");
  });

  return router;
}
