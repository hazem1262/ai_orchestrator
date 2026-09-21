import type { InboxItem } from '@orc/core';
import { z } from 'zod';

export const InboxKindSchema = z.enum([
  'waiting',
  'review',
  'plan_approval',
  'blocked',
  'error',
  'tests_red',
  'budget',
  'automation_result',
  'supervisor_escalation',
  'pr_event',
  'reminder',
]);
export type InboxKindSchema = z.output<typeof InboxKindSchema>;

export const InboxStateSchema = z.enum(['open', 'snoozed', 'done', 'auto_resolved']);
export type InboxStateSchema = z.output<typeof InboxStateSchema>;

/** GET /api/inbox response item. `reason` and `payload` may carry transcript-derived text — see task-2-report.md. */
export const InboxItemSchema: z.ZodType<InboxItem> = z.object({
  id: z.string(),
  kind: InboxKindSchema,
  sessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  ticket: z.string().nullable(),
  reason: z.string(),
  dedupeKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: InboxStateSchema,
  snoozeUntil: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** GET /api/inbox?state&kind&projectId — a query schema, so it stays permissive (no `.strict()`). */
export const InboxListQuery = z.object({
  state: z.string().transform(csv).pipe(z.array(InboxStateSchema)).optional(),
  kind: z.string().transform(csv).pipe(z.array(InboxKindSchema)).optional(),
  projectId: z.string().optional(),
});
export type InboxListQuery = z.output<typeof InboxListQuery>;

/** POST /api/inbox/:id/(done|snooze|reopen) body. */
export const InboxActionBody = z.strictObject({ until: z.string().optional() });
export type InboxActionBody = z.output<typeof InboxActionBody>;
