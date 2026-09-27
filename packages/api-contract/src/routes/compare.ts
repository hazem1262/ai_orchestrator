import { z } from 'zod';
import { TestResultSchema } from '../domain.ts';
import { DiffStatSchema } from './p7-common.ts';

const VariantSource = z.enum(['claude', 'codex']);

export const CompareVariantInput = z.object({ source: VariantSource, model: z.string().min(1).optional() });
export type CompareVariantInput = z.infer<typeof CompareVariantInput>;

export const CompareVariant = z.object({
  index: z.number().int().min(0),
  source: VariantSource,
  model: z.string().nullable(),
  label: z.string(),
  sessionId: z.string().nullable(),
  sessionPk: z.string().nullable(),
  ptyId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  error: z.string().nullable(),
});
export type CompareVariant = z.infer<typeof CompareVariant>;

export const CompareGroup = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  prompt: z.string(),
  ticket: z.string().nullable(),
  repo: z.string(),
  base: z.string(),
  createdAt: z.string(),
  state: z.enum(['running', 'decided', 'archived']),
  winnerIndex: z.number().int().nullable(),
  estimateUsd: z.number().nullable(),
  variants: z.array(CompareVariant),
});
export type CompareGroup = z.infer<typeof CompareGroup>;

export const CompareEstimate = z.object({
  variants: z.number().int(),
  multiplier: z.number(),
  avgSessionCostUsd: z.number().nullable(),
  estimatedUsd: z.number().nullable(),
  sample: z.number().int(),
  burnRateUsdPerHour: z.number(),
  budget: z.object({ ok: z.boolean(), pct: z.number(), limitUsd: z.number().nullable() }),
});
export type CompareEstimate = z.infer<typeof CompareEstimate>;

export const CompareVariantView = CompareVariant.extend({
  status: z.string(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  tests: TestResultSchema.nullable(),
  recap: z.string().nullable(),
  diff: DiffStatSchema.nullable(),
});
export type CompareVariantView = z.infer<typeof CompareVariantView>;

export const CompareView = z.object({ group: CompareGroup, variants: z.array(CompareVariantView) });
export type CompareView = z.infer<typeof CompareView>;

export const ArchiveLosersResult = z.object({
  group: CompareGroup,
  results: z.array(
    z.object({
      index: z.number().int(),
      worktreePath: z.string().nullable(),
      killed: z.boolean(),
      archived: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});
export type ArchiveLosersResult = z.infer<typeof ArchiveLosersResult>;

export const PickWinnerBody = z.object({ index: z.number().int().min(0) });
export const PickWinnerResult = z.object({ group: CompareGroup, reviewUrl: z.string() });
export type PickWinnerResult = z.infer<typeof PickWinnerResult>;
export const CompareEstimateQuery = z.object({
  projectId: z.string().optional(),
  n: z.coerce.number().int().min(1).max(6),
});
