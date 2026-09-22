/**
 * Orçamento por partida de um bot (docs/09, seção 3.6): chamadas, tokens, custo e lances
 * ilegais. Zera a cada `new_game`. Quando um limite estoura, o BotPlayer para com status
 * `budget_exceeded` e publica um comentário de sistema.
 */
import type { BotLimits, BotUsage } from "../../../shared/types.js";
import { emptyBotUsage } from "../game/store.js";
import type { ChatUsage } from "./providers/types.js";

/** Defaults aprovados (docs/09, seção 11, decisão 5). */
export const DEFAULT_LIMITS: Required<BotLimits> = {
  maxTokensPerGame: 400_000,
  maxUsdPerGame: 1.0,
  maxIterationsPerTurn: 6,
};

export interface BudgetOptions {
  limits?: BotLimits;
  /** Provedor pago: só aí o limite em dólares vale (local sempre custa 0). */
  paid?: boolean;
}

function fmtUsd(v: number): string {
  return `US$ ${v.toFixed(2)}`;
}

export class Budget {
  private state: BotUsage = emptyBotUsage();
  private readonly limits: Required<BotLimits>;
  private readonly paid: boolean;

  constructor(opts: BudgetOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.paid = opts.paid ?? false;
  }

  /** Cópia do uso acumulado (vai para `seat.bot.usage`). */
  get usage(): BotUsage {
    return { ...this.state };
  }

  get maxIterationsPerTurn(): number {
    return Math.max(1, this.limits.maxIterationsPerTurn);
  }

  reset(): void {
    this.state = emptyBotUsage();
  }

  /** Contabiliza uma chamada ao provedor. */
  addCall(usage?: ChatUsage): void {
    this.state.calls += 1;
    if (!usage) return;
    this.state.inputTokens += usage.inputTokens || 0;
    this.state.outputTokens += usage.outputTokens || 0;
    if (usage.cachedInputTokens) this.state.cachedInputTokens = (this.state.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    if (usage.costUsd !== undefined) this.state.estimatedCostUsd = (this.state.estimatedCostUsd ?? 0) + usage.costUsd;
  }

  addIllegal(n = 1): void {
    this.state.illegalMoves += n;
  }

  get totalTokens(): number {
    return this.state.inputTokens + this.state.outputTokens;
  }

  /** Motivo em pt-BR se algum limite estourou, senão `null`. */
  exceeded(): string | null {
    if (this.limits.maxTokensPerGame > 0 && this.totalTokens >= this.limits.maxTokensPerGame) {
      return `limite de ${this.limits.maxTokensPerGame.toLocaleString("pt-BR")} tokens por partida atingido`;
    }
    const cost = this.state.estimatedCostUsd ?? 0;
    if (this.paid && this.limits.maxUsdPerGame > 0 && cost >= this.limits.maxUsdPerGame) {
      return `limite de ${fmtUsd(this.limits.maxUsdPerGame)} por partida atingido (${fmtUsd(cost)} gastos)`;
    }
    return null;
  }
}
