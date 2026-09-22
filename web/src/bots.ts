/**
 * Vocabulário de bots no navegador (docs/09 §4.3, §5.1).
 *
 * O backend manda `BotSeatInfo` cru (status, uso, custo); aqui ele vira texto em
 * português, tom de cor e os limites que a UI promete ao usuário antes de
 * começar uma partida paga.
 *
 * Nada aqui fala com a rede e nada aqui conhece chave de API: a UI só vê o
 * estado mascarado que a API devolve (decisão aprovada, docs/09 §6).
 */
import type { BotProfile, BotSeatInfo, BotStatus, BotUsage, ProviderPublic } from "@shared/types";

/** Tom visual reaproveitado das placas (`.dot.tone-*`, `.tone-text-*`). */
export type BotTone = "ok" | "busy" | "bad" | "idle";

export const BOT_STATUS_LABEL: Record<BotStatus, string> = {
  idle: "pronta",
  waiting: "esperando a vez",
  thinking: "pensando…",
  acting: "jogando…",
  error: "erro",
  budget_exceeded: "limite de gasto atingido",
  stopped: "parada",
};

export const BOT_STATUS_TONE: Record<BotStatus, BotTone> = {
  idle: "ok",
  waiting: "ok",
  thinking: "busy",
  acting: "busy",
  error: "bad",
  budget_exceeded: "bad",
  stopped: "idle",
};

/** `status` é terminal quando o bot não volta a jogar sozinho. */
export function isStoppedStatus(status: BotStatus): boolean {
  return status === "stopped" || status === "error" || status === "budget_exceeded";
}

/**
 * Limites default mostrados ao usuário (decisão aprovada, docs/09 §11).
 * O servidor tem os mesmos valores; aqui eles servem só para o aviso de custo.
 */
export const DEFAULT_LIMITS = { maxUsdPerGame: 1.0, maxTokensPerGame: 400_000 } as const;

export function limitsOf(profile?: BotProfile | null): { usd: number; tokens: number } {
  return {
    usd: profile?.limits?.maxUsdPerGame ?? DEFAULT_LIMITS.maxUsdPerGame,
    tokens: profile?.limits?.maxTokensPerGame ?? DEFAULT_LIMITS.maxTokensPerGame,
  };
}

/** "980", "12k", "1,2M" — o número exato não ajuda ninguém numa placa. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`.replace(".", ",");
  return `${Math.round(value / 100_000) / 10}M`.replace(".", ",");
}

const USD = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const USD_TINY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 4 });

/** `undefined` quando o provedor não informa preço (local, gateway sem pricing). */
export function formatUsd(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value > 0 && value < 0.01) return USD_TINY.format(value);
  return USD.format(value);
}

/** "12k tok · US$ 0,03" — resumo discreto de uso para a placa (docs/09 §4.3). */
export function usageText(usage: BotUsage): string {
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = [`${formatTokens(tokens)} tok`];
  const cost = formatUsd(usage.estimatedCostUsd);
  if (cost) parts.push(cost);
  if (usage.illegalMoves > 0) parts.push(`${usage.illegalMoves} ilegal${usage.illegalMoves > 1 ? "is" : ""}`);
  return parts.join(" · ");
}

/** Texto longo para leitor de tela, onde "tok" e "·" não ajudam. */
export function usageSpoken(usage: BotUsage): string {
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = [`${tokens} tokens em ${usage.calls} chamada${usage.calls === 1 ? "" : "s"}`];
  const cost = formatUsd(usage.estimatedCostUsd);
  if (cost) parts.push(`custo estimado ${cost}`);
  if (usage.illegalMoves > 0) parts.push(`${usage.illegalMoves} lance ilegal recusado`);
  return parts.join(", ");
}

/** "openrouter · anthropic/claude-sonnet-4.6". */
export function botSubtitle(bot: BotSeatInfo): string {
  return `${bot.providerId} · ${bot.model}`;
}

export function providerName(providers: ProviderPublic[] | undefined, id: string): string {
  return providers?.find((p) => p.id === id)?.name ?? id;
}

export function profileName(profiles: BotProfile[] | undefined, id: string | undefined): string | null {
  if (!id) return null;
  return profiles?.find((p) => p.id === id)?.name ?? id;
}

/** "12 s", "1 min 05 s", "12 min" — para "pensando há …" (docs/10 §4). */
export function elapsedText(sinceIso: string | undefined, now: number): string | null {
  if (!sinceIso) return null;
  const started = Date.parse(sinceIso);
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 10) return `${minutes} min ${String(rest).padStart(2, "0")} s`;
  return `${minutes} min`;
}

/** Depois de 90 s a espera deixa de ser normal (docs/10 §4). */
export const SLOW_THINKING_MS = 90_000;

/**
 * Estado do provedor na tela "Provedores": ● ok / ○ sem chave / ✗ erro.
 *
 * O texto fala só do **último teste** — a situação da chave é impressa logo
 * depois, pelo próprio diálogo, para não sair duplicada na mesma linha.
 */
export function providerTone(provider: ProviderPublic): { tone: BotTone; text: string; mark: string } {
  if (provider.lastTest && !provider.lastTest.ok) {
    return { tone: "bad", text: `último teste falhou: ${provider.lastTest.error || "sem detalhe"}`, mark: "✗" };
  }
  if (provider.lastTest?.ok) {
    const models = provider.lastTest.models;
    return {
      tone: "ok",
      text: `testado${provider.lastTest.latencyMs ? ` em ${provider.lastTest.latencyMs} ms` : ""}${
        models ? ` · ${models} modelo${models === 1 ? "" : "s"}` : ""
      }`,
      mark: "●",
    };
  }
  if (provider.apiKeyEnv && !provider.hasApiKey) return { tone: "idle", text: "sem chave, não testado", mark: "○" };
  return { tone: "idle", text: "não testado", mark: "●" };
}
