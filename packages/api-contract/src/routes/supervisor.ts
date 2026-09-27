import { z } from 'zod';

export const SupervisorIntent = z.enum(['continue', 'run_tests', 'proceed_plan', 'retry_transient']);
export type SupervisorIntent = z.infer<typeof SupervisorIntent>;

export const SupervisorRule = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  kind: z.enum(['allow', 'deny']),
  pattern: z.string(),
  intent: SupervisorIntent.nullable(),
  answer: z.string().nullable(),
  source: z.enum(['builtin', 'user', 'feedback']),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type SupervisorRule = z.infer<typeof SupervisorRule>;

export const SupervisorRuleInput = z.object({
  projectId: z.string().nullable().default(null),
  kind: z.enum(['allow', 'deny']),
  pattern: z.string().min(2).max(400),
  intent: SupervisorIntent.nullable().default(null),
  answer: z.string().max(500).nullable().default(null),
  note: z.string().max(300).nullable().default(null),
});
export type SupervisorRuleInput = z.infer<typeof SupervisorRuleInput>;

export const SupervisorTarget = z.object({
  targetType: z.enum(['project', 'session']),
  targetId: z.string().min(1),
  enabled: z.boolean(),
});
export type SupervisorTarget = z.infer<typeof SupervisorTarget>;

/** Contracts §11 SupervisorDecision plus the fields the UI and the caps need. */
export const SupervisorDecisionView = z.object({
  id: z.string(),
  sessionPk: z.string(),
  projectId: z.string().nullable(),
  question: z.string(),
  decision: z.enum(['answer', 'escalate']),
  answer: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
  intent: SupervisorIntent.nullable(),
  sent: z.boolean(),
  costUsd: z.number().nullable(),
  model: z.string().nullable(),
  feedback: z.literal('wrong').nullable(),
  ts: z.string(),
});
export type SupervisorDecisionView = z.infer<typeof SupervisorDecisionView>;

export const QuietHours = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const SupervisorStatus = z.object({
  enabled: z.boolean(),
  quiet: z.boolean(),
  model: z.string(),
  confidenceThreshold: z.number(),
  maxPerSessionPerHour: z.number().int(),
  maxPerHour: z.number().int(),
  quietHours: QuietHours.nullable(),
  answeredLastHour: z.number().int(),
  escalatedLastHour: z.number().int(),
  monthCostUsd: z.number(),
  monthBudgetUsd: z.number(),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatus>;

export const SupervisorSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  maxPerSessionPerHour: z.number().int().min(0).max(50).optional(),
  maxPerHour: z.number().int().min(0).max(200).optional(),
  monthlyBudgetUsd: z.number().min(0).max(200).optional(),
  quietHours: QuietHours.nullable().optional(),
});
export type SupervisorSettingsPatch = z.infer<typeof SupervisorSettingsPatch>;

export const SupervisorDecisionQuery = z.object({
  sessionPk: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type SupervisorDecisionQuery = z.infer<typeof SupervisorDecisionQuery>;
