import type {
  CostRow,
  DigestRecord,
  OutcomesResult,
  TimingResult,
  ToolUsageRow,
  TopResult,
  WstackSkillRow,
} from '@orc/core';
import { z } from 'zod';

const TokenTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

export const AnalyticsRangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  projectId: z.string().optional(),
});
export type AnalyticsRangeQuery = z.infer<typeof AnalyticsRangeQuery>;
export const AnalyticsCostQuery = AnalyticsRangeQuery.extend({
  groupBy: z.enum(['day', 'week', 'project', 'model', 'source', 'ticket']).default('day'),
});
export type AnalyticsCostQuery = z.input<typeof AnalyticsCostQuery>;
export const AnalyticsTopQuery = AnalyticsRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export type AnalyticsTopQuery = { from?: string; to?: string; projectId?: string; limit?: number };
export const AnalyticsBucketQuery = AnalyticsRangeQuery.extend({
  bucket: z.enum(['day', 'week']).default('day'),
});
export type AnalyticsBucketQuery = z.input<typeof AnalyticsBucketQuery>;

export const CostRowSchema: z.ZodType<CostRow> = z.object({
  key: z.string(),
  costUsd: z.number(),
  tokens: TokenTotalsSchema,
  sessions: z.number(),
});
export const CostResponseSchema = z.object({ rows: z.array(CostRowSchema), estimated: z.boolean() });
export type CostResponse = z.infer<typeof CostResponseSchema>;

export const TopResultSchema: z.ZodType<TopResult> = z.object({
  sessions: z.array(
    z.object({
      pk: z.string(),
      name: z.string().nullable(),
      projectId: z.string().nullable(),
      costUsd: z.number(),
      tickets: z.array(z.string()),
    }),
  ),
  tickets: z.array(z.object({ ticket: z.string(), costUsd: z.number(), sessions: z.number() })),
  mergedPrs: z.number(),
  costPerMergedPrUsd: z.number().nullable(),
});

export const ToolUsageRowSchema: z.ZodType<ToolUsageRow> = z.object({
  bucket: z.string(),
  kind: z.enum(['tool', 'mcp', 'skill']),
  name: z.string(),
  count: z.number(),
});

export const TimingResultSchema: z.ZodType<TimingResult> = z.object({
  modelMs: z.number(),
  toolMs: z.number(),
  modelShare: z.number().nullable(),
  cacheHitTrend: z.array(z.object({ bucket: z.string(), rate: z.number().nullable() })),
});

export const OutcomesResultSchema: z.ZodType<OutcomesResult> = z.object({
  sessions: z.number(),
  outcomes: z.record(z.string(), z.number()),
  friction: z.record(z.string(), z.number()),
  goalCategories: z.record(z.string(), z.number()),
});

export const WstackSkillRowSchema: z.ZodType<WstackSkillRow> = z.object({
  skill: z.string(),
  runs: z.number(),
  outcomes: z.record(z.string(), z.number()),
  avgDurationS: z.number().nullable(),
});

export const DigestRecordSchema: z.ZodType<DigestRecord> = z.object({
  weekStart: z.string(),
  markdown: z.string(),
  createdAt: z.string(),
});
export const DigestGenerateBody = z.object({
  weekStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
