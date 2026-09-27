import type { Recap } from '@orc/core';
import { z } from 'zod';

export const RecapSchema: z.ZodType<Recap> = z.object({
  id: z.string(),
  kind: z.enum(['session', 'daily', 'handoff']),
  targetKey: z.string(),
  transcriptOffset: z.number(),
  model: z.string(),
  engine: z.enum(['claude-cli', 'anthropic-api']),
  text: z.string(),
  costUsd: z.number(),
  inputTokensApprox: z.number(),
  createdAt: z.string(),
});
export const RecapRunBody = z.object({ onDemand: z.boolean().default(true) });
export const RecapRunResponseSchema = z.object({
  text: z.string(),
  costUsd: z.number(),
  model: z.string(),
  cached: z.boolean(),
});
export type RecapRunResponse = z.infer<typeof RecapRunResponseSchema>;
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DailyRecapQuery = z.object({ projectId: z.string(), date: IsoDate });
export const DailyRecapBody = z.object({ projectId: z.string(), date: IsoDate });
export const RecapSpendSchema = z.object({ spentUsd: z.number(), budgetUsd: z.number() });
