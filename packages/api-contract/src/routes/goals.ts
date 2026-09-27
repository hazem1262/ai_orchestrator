import { z } from 'zod';
import { GoalSchema } from './streams.ts';

export const GoalTargetTypeSchema = z.enum(['session', 'stream']);
export const GoalStateSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
export const GoalWithPrefillSchema = z.object({ goal: GoalSchema.nullable(), prefill: z.string() });
export const GoalPutBody = z.object({
  objective: z.string().min(1).max(2000),
  state: GoalStateSchema,
  blockedReason: z.string().max(500).nullable().default(null),
});
export type GoalPutBody = z.input<typeof GoalPutBody>;
/** `state` is a comma-separated list of `GoalState` values. */
export const GoalsListQuery = z.object({ state: z.string().optional() });
