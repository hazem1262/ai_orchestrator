import type {
  Budget,
  BudgetStatus,
  ConcurrencyStatus,
  ContextFillInfo,
  OfficialQuotaSample,
  UsageSnapshot,
} from '@orc/core';
import { z } from 'zod';

export const UsageSnapshotSchema: z.ZodType<UsageSnapshot> = z.object({
  source: z.enum(['official', 'estimate']),
  generatedAt: z.string(),
  block: z.object({
    active: z.boolean(),
    start: z.string(),
    end: z.string(),
    tokens: z.number(),
    costUsd: z.number(),
    pctOfLimit: z.number().nullable(),
  }),
  week: z.object({ tokens: z.number(), costUsd: z.number(), pctOfLimit: z.number().nullable() }),
  burnRateUsdPerHour: z.number(),
  burnRateTokensPerMin: z.number(),
  projectedBlockExhaustionAt: z.string().nullable(),
});

export const OfficialQuotaSampleSchema: z.ZodType<OfficialQuotaSample> = z.object({
  at: z.string(),
  blockPct: z.number().nullable(),
  blockResetsAt: z.string().nullable(),
  weekPct: z.number().nullable(),
  weekResetsAt: z.string().nullable(),
});

export const BudgetScopeTypeSchema = z.enum(['global', 'project', 'ticket']);
export const BudgetPeriodSchema = z.enum(['daily', 'weekly', 'monthly']);

export const BudgetSchema: z.ZodType<Budget> = z.object({
  id: z.string(),
  scopeType: BudgetScopeTypeSchema,
  scopeId: z.string().nullable(),
  period: BudgetPeriodSchema,
  limitUsd: z.number(),
  origin: z.enum(['table', 'config']),
});

export const BudgetStatusSchema: z.ZodType<BudgetStatus> = z.object({
  budget: BudgetSchema,
  spentUsd: z.number(),
  pct: z.number(),
  periodStart: z.string(),
});

export const BudgetUpsertBody = z
  .object({
    scopeType: BudgetScopeTypeSchema,
    scopeId: z.string().min(1).nullable().default(null),
    period: BudgetPeriodSchema,
    limitUsd: z.number().positive(),
  })
  .refine((b) => (b.scopeType === 'global') === (b.scopeId === null), {
    message: 'scopeId must be null only for global budgets',
  });
export type BudgetUpsertBody = z.infer<typeof BudgetUpsertBody>;

export const ConcurrencyStatusSchema: z.ZodType<ConcurrencyStatus> = z.object({
  projectId: z.string(),
  owned: z.number(),
  max: z.number(),
});

export const ContextFillInfoSchema: z.ZodType<ContextFillInfo> = z.object({
  sessionPk: z.string(),
  model: z.string().nullable(),
  usedTokens: z.number(),
  windowTokens: z.number(),
  fill: z.number(),
  warn: z.boolean(),
});
