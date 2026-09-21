import { z } from 'zod';
import {
  AvailabilitySchema,
  LiveStateSchema,
  PrRefSchema,
  SourceSchema,
  TimelineEventSchema,
} from '../domain.ts';

export const SNIPPET_OPEN = '⟦';
export const SNIPPET_CLOSE = '⟧';
export const HIDDEN_LABEL = 'hidden';
export const ALL_PROJECTS = 'all';

const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export const SessionListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().optional(),
  source: SourceSchema.optional(),
  ticket: z.string().optional(),
  pr: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  model: z.string().optional(),
  minCost: z.coerce.number().min(0).optional(),
  maxCost: z.coerce.number().min(0).optional(),
  skill: z.string().optional(),
  hasSubagents: boolParam.optional(),
  touchedProd: boolParam.optional(),
  availability: AvailabilitySchema.optional(),
  label: z.string().optional(),
  pinned: boolParam.optional(),
  includeHidden: boolParam.optional(),
  includeAutomated: boolParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type SessionListFilters = z.output<typeof SessionListQuerySchema>;

export const SessionListItemSchema = z.object({
  pk: z.string(),
  source: SourceSchema,
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  lastPrompt: z.string().nullable(),
  recap: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  durationMs: z.number(),
  costUsd: z.number().nullable(),
  tickets: z.array(z.string()),
  prs: z.array(PrRefSchema),
  availability: AvailabilitySchema,
  pinned: z.boolean(),
  labels: z.array(z.string()),
  live: LiveStateSchema.nullable(),
  snippet: z.string().nullable(),
});
export type SessionListItem = z.output<typeof SessionListItemSchema>;

export const SessionListResponseSchema = z.object({
  items: z.array(SessionListItemSchema),
  nextCursor: z.string().nullable(),
});
export type SessionListResponse = z.output<typeof SessionListResponseSchema>;

export const SessionEventsQuerySchema = z.object({
  agentId: z.string().optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const SessionEventsResponseSchema = z.object({
  items: z.array(TimelineEventSchema),
  nextSeq: z.number().int().nullable(),
});
export type SessionEventsResponse = z.output<typeof SessionEventsResponseSchema>;

export const ResumeRequestSchema = z.strictObject({
  mode: z.enum(['embedded', 'external']),
  fork: z.boolean().optional(),
  popOut: z.boolean().optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(300).optional(),
});
export type ResumeRequest = z.output<typeof ResumeRequestSchema>;

export const ResumeResponseSchema = z.union([
  z.object({ ptyId: z.string() }),
  z.object({ launched: z.literal('external'), command: z.string() }),
]);
export type ResumeResponse = z.output<typeof ResumeResponseSchema>;

export const PinRequestSchema = z.strictObject({ pinned: z.boolean() });
export const PinResponseSchema = PinRequestSchema;
export const LabelRequestSchema = z.strictObject({
  labels: z.array(z.string().trim().min(1).max(40)).max(20),
});
export const LabelResponseSchema = z.object({ labels: z.array(z.string()) });
export const LabelsListSchema = z.array(z.string());
export const OkSchema = z.object({ ok: z.literal(true) });
