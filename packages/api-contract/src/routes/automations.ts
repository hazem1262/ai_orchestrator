import { z } from 'zod';
import { DiffStatSchema } from './p7-common.ts';
import { TemplateVarSchema } from './templates.ts';

export const AutomationTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), cron: z.string().min(9).max(120) }),
  z.object({ type: z.literal('github'), event: z.enum(['review_comment', 'check_failed', 'pr_merged']) }),
  z.object({
    type: z.literal('linear'),
    event: z.enum(['assigned', 'labeled']),
    label: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('slack'), event: z.literal('mention'), channel: z.string().min(1) }),
  z.object({ type: z.literal('manual') }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationAction = z.object({
  templateId: z.string().min(1),
  projectId: z.string().min(1),
  repo: z.string().min(1).optional(),
  useWorktree: z.boolean(),
  headless: z.boolean(),
  model: z.string().min(1).optional(),
  timeoutMin: z.number().int().min(1).max(240),
  planApproval: z.boolean(),
});
export type AutomationAction = z.infer<typeof AutomationAction>;

export const Automation = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  budgetUsd: z.number().positive().max(500),
});
export type Automation = z.infer<typeof Automation>;

export const AutomationInput = Automation.extend({ id: z.string().min(1).optional() });
export type AutomationInput = z.infer<typeof AutomationInput>;

/** POST /api/automations/:id/run body: values for the template's `{{var}}` placeholders. */
export const AutomationRunRequest = z.strictObject({
  vars: z.partialRecord(TemplateVarSchema, z.string()).optional(),
});
export type AutomationRunRequest = z.infer<typeof AutomationRunRequest>;

export const AutomationRunStatus = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'success',
  'failed',
  'denied',
  'over_budget',
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;
export const TriggerSource = z.enum(['cron', 'github', 'linear', 'slack', 'manual', 'rerun']);
export type TriggerSource = z.infer<typeof TriggerSource>;

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: AutomationRunStatus,
  sessionPk: z.string().nullable(),
  costUsd: z.number().nullable(),
  summary: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunDetail = AutomationRun.extend({
  triggerKey: z.string(),
  triggerSource: TriggerSource,
  vars: z.record(z.string(), z.string()),
  ptyId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  prUrl: z.string().nullable(),
  diffStat: DiffStatSchema.nullable(),
  error: z.string().nullable(),
  rerunOf: z.string().nullable(),
});
export type AutomationRunDetail = z.infer<typeof AutomationRunDetail>;

export const RunStats = z.object({
  total: z.number().int(),
  success: z.number().int(),
  failed: z.number().int(),
  successRate: z.number().nullable(),
  lastRunAt: z.string().nullable(),
  monthSpendUsd: z.number(),
});
export type RunStats = z.infer<typeof RunStats>;

export const AutomationWithStats = Automation.extend({ stats: RunStats, nextRunAt: z.string().nullable() });
export type AutomationWithStats = z.infer<typeof AutomationWithStats>;

export const Suggestion = z.object({
  id: z.string(),
  source: z.enum(['linear', 'todo']),
  projectId: z.string().nullable(),
  title: z.string(),
  detail: z.string(),
  ticket: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  state: z.enum(['new', 'accepted', 'dismissed']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  runPtyId: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const AutomationSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(10).optional(),
  suggestionsEnabled: z.boolean().optional(),
});
export type AutomationSettingsPatch = z.infer<typeof AutomationSettingsPatch>;

export const AutomationSettings = z.object({
  enabled: z.boolean(),
  maxConcurrent: z.number().int(),
  suggestionsEnabled: z.boolean(),
});
export type AutomationSettings = z.infer<typeof AutomationSettings>;
