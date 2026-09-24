import { z } from 'zod';
import { UsageSchema } from '../domain.ts';

export const SourceParam = z.enum(['claude', 'codex', 'agnc']);

export const TurnStatsSchema = z.object({
  turn: z.number(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  wallMs: z.number(),
  modelMs: z.number(),
  toolMs: z.number(),
  reportedMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  apiErrors: z.number(),
  usage: UsageSchema,
  tokensPerSec: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
});

export const SessionStatsSchema = z.object({
  turns: z.number(),
  wallMs: z.number(),
  modelMs: z.number(),
  toolMs: z.number(),
  ttftMs: z.number().nullable(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  apiErrors: z.number(),
  usage: UsageSchema,
  tokensPerSec: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
});

export const SessionStatsResponse = z.object({
  session: SessionStatsSchema,
  turns: z.array(TurnStatsSchema),
  agents: z.array(z.object({ agentId: z.string(), stats: SessionStatsSchema })),
});
export type SessionStatsResponse = z.infer<typeof SessionStatsResponse>;

export const DeliverableStatusSchema = z.enum(['applied', 'failed', 'pending']);

export const DeliverableFileSchema = z.object({
  path: z.string(),
  tools: z.array(z.string()),
  ops: z.number(),
  status: DeliverableStatusSchema,
  lastTs: z.string(),
});

export const TurnDeliverablesSchema = z.object({
  turn: z.number(),
  agentId: z.string().nullable(),
  files: z.array(DeliverableFileSchema),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  tool: z.string(),
  toolUseId: z.string().nullable(),
  turn: z.number(),
  seq: z.number(),
  ts: z.string(),
  agentId: z.string().nullable(),
  status: DeliverableStatusSchema,
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
});

export const FileSummarySchema = z.object({
  path: z.string(),
  ops: z.number(),
  failedOps: z.number(),
  turns: z.array(z.number()),
  agentIds: z.array(z.string().nullable()),
  firstTs: z.string(),
  lastTs: z.string(),
  changes: z.array(FileChangeSchema),
});

export const UsagePointSchema = z.object({
  ts: z.string(),
  agentId: z.string().nullable(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});
export type UsagePoint = z.infer<typeof UsagePointSchema>;

export const ProdTouchSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  agentId: z.string().nullable(),
  kind: z.enum(['skill', 'command']),
  tool: z.string(),
  detail: z.string(),
});

export const PermissionBadgeSchema = z.enum(['bypass', 'plan', 'auto', 'default', 'custom', 'unknown']);

export const SessionSafetySchema = z.object({
  permissionMode: z.string().nullable(),
  permissionBadge: PermissionBadgeSchema,
  touchedProd: z.boolean(),
  prodTouches: z.array(ProdTouchSchema),
});
export type SessionSafety = z.infer<typeof SessionSafetySchema>;

export const RawLineSchema = z.object({
  offset: z.number(),
  text: z.string(),
  truncated: z.boolean(),
  partial: z.boolean(),
});
export type RawLine = z.infer<typeof RawLineSchema>;

export const RawPageSchema = z.object({
  path: z.string(),
  items: z.array(RawLineSchema),
  nextOffset: z.number().nullable(),
});
export type RawPage = z.infer<typeof RawPageSchema>;

export const RawQuery = z.object({
  agentId: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const ExportQuery = z.object({
  redact: z.enum(['true', 'false']).default('true'),
  confirm: z.enum(['true', 'false']).default('false'),
});
