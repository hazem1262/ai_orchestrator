export type UsageSource = 'official' | 'estimate';

/** `pctOfLimit` is a fraction (0..1, may exceed 1). */
export interface UsageSnapshot {
  source: UsageSource;
  generatedAt: string;
  block: {
    active: boolean;
    start: string;
    end: string;
    tokens: number;
    costUsd: number;
    pctOfLimit: number | null;
  };
  week: { tokens: number; costUsd: number; pctOfLimit: number | null };
  burnRateUsdPerHour: number;
  burnRateTokensPerMin: number;
  projectedBlockExhaustionAt: string | null;
}

export interface OfficialQuotaSample {
  at: string;
  blockPct: number | null;
  blockResetsAt: string | null;
  weekPct: number | null;
  weekResetsAt: string | null;
}

export type BudgetScopeType = 'global' | 'project' | 'ticket';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface Budget {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  origin: 'table' | 'config';
}

export interface BudgetStatus {
  budget: Budget;
  spentUsd: number;
  pct: number;
  periodStart: string;
}
export interface BudgetCheck {
  ok: boolean;
  pct: number;
  limitUsd: number | null;
}
export interface ConcurrencyStatus {
  projectId: string;
  owned: number;
  max: number;
}

export interface ContextFillInfo {
  sessionPk: string;
  model: string | null;
  usedTokens: number;
  windowTokens: number;
  fill: number;
  warn: boolean;
}
