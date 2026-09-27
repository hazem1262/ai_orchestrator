import type {
  Goal,
  Handoff,
  StreamDetail,
  StreamLink,
  StreamPr,
  StreamTimelineItem,
  WorkStream,
} from '@orc/core';
import { z } from 'zod';
import { PrRefSchema } from '../domain.ts';

export const StreamStageSchema = z.enum([
  'planned',
  'implementing',
  'in_review',
  'pr_open',
  'merged',
  'backmerged',
  'released',
]);
export const StreamLinkKindSchema = z.enum(['session', 'pr', 'plan', 'worktree', 'workflow']);

export const WorkStreamSchema: z.ZodType<WorkStream> = z.object({
  ticket: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  stage: StreamStageSchema,
  sessionIds: z.array(z.string()),
  prs: z.array(PrRefSchema),
  plans: z.array(z.string()),
  worktrees: z.array(z.string()),
  costUsd: z.number(),
  lastActivityAt: z.string(),
});

export const StreamLinkSchema: z.ZodType<StreamLink> = z.object({
  ticket: z.string(),
  kind: StreamLinkKindSchema,
  ref: z.string(),
  origin: z.enum(['auto', 'manual']),
  excluded: z.boolean(),
  createdAt: z.string(),
});

export const StreamPrSchema: z.ZodType<StreamPr> = z.object({
  pr: PrRefSchema,
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  isBackmerge: z.boolean(),
  checks: z.enum(['pending', 'success', 'failure', 'none']),
  review: z.enum(['approved', 'changes_requested', 'review_required', 'none']),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
});

export const StreamTimelineItemSchema: z.ZodType<StreamTimelineItem> = z.object({
  ts: z.string(),
  kind: z.enum(['session', 'pr', 'plan', 'worktree', 'recap', 'handoff', 'goal', 'workflow']),
  title: z.string(),
  ref: z.string(),
  detail: z.string().nullable(),
});

export const GoalSchema: z.ZodType<Goal> = z.object({
  id: z.string(),
  targetType: z.enum(['session', 'stream']),
  targetId: z.string(),
  objective: z.string(),
  state: z.enum(['active', 'paused', 'blocked', 'complete']),
  blockedReason: z.string().nullable(),
  updatedAt: z.string(),
});

export const HandoffSchema: z.ZodType<Handoff> = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  files: z.array(z.string()),
  nextSteps: z.array(z.string()),
  blockers: z.array(z.string()),
  links: z.array(z.string()),
  createdAt: z.string(),
});

export const StreamDetailSchema: z.ZodType<StreamDetail> = z.object({
  stream: WorkStreamSchema,
  prsDetailed: z.array(StreamPrSchema),
  links: z.array(StreamLinkSchema),
  timeline: z.array(StreamTimelineItemSchema),
  goal: GoalSchema.nullable(),
  handoff: HandoffSchema.nullable(),
  budget: z.object({ ok: z.boolean(), pct: z.number(), limitUsd: z.number().nullable() }),
});

export const StreamsListQuery = z.object({
  projectId: z.string().optional(),
  stage: StreamStageSchema.optional(),
});
export type StreamsListQuery = z.infer<typeof StreamsListQuery>;
export const StreamLinkBody = z.object({ kind: StreamLinkKindSchema, ref: z.string().min(1) });
export type StreamLinkBody = z.infer<typeof StreamLinkBody>;
