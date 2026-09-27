import type { GoalState, ReminderState, StreamLinkKind, StreamStage } from '@orc/core';
import { z } from 'zod';
import type { Caller, HttpMethod } from './client-p2.ts';
import {
  type AnalyticsBucketQuery,
  type AnalyticsCostQuery,
  type AnalyticsTopQuery,
  CostResponseSchema,
  DigestRecordSchema,
  OutcomesResultSchema,
  TimingResultSchema,
  ToolUsageRowSchema,
  TopResultSchema,
  WstackSkillRowSchema,
} from './routes/analytics.ts';
import { type GoalPutBody, GoalWithPrefillSchema } from './routes/goals.ts';
import { HandoffWithMarkdownSchema, ResumeFreshResponseSchema } from './routes/handoffs.ts';
import { HookInstallResultSchema, HookInstallStatusSchema, StatuslineSnippetSchema } from './routes/hooks.ts';
import { RecapRunResponseSchema, RecapSchema, RecapSpendSchema } from './routes/recaps.ts';
import { type ReminderCreateBody, ReminderSchema } from './routes/reminders.ts';
import { OkSchema } from './routes/sessions.ts';
import { SettingsSchema, type SettingsUpdateBody } from './routes/settings.ts';
import {
  GoalSchema,
  HandoffSchema,
  StreamDetailSchema,
  StreamLinkSchema,
  WorkStreamSchema,
} from './routes/streams.ts';
import {
  BudgetSchema,
  BudgetStatusSchema,
  ConcurrencyStatusSchema,
  ContextFillInfoSchema,
  UsageSnapshotSchema,
} from './routes/usage.ts';

export type QueryValue = string | number | boolean | undefined;

/** Appends `q` as a query string, dropping `undefined` and empty-string values. */
export function withQuery(path: string, q: Record<string, QueryValue>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `${path}?${s}` : path;
}

const enc = encodeURIComponent;

export interface BudgetUpsertInput {
  scopeType: 'global' | 'project' | 'ticket';
  scopeId?: string | null;
  period: 'daily' | 'weekly' | 'monthly';
  limitUsd: number;
}

/** Typed phase-5 client methods, merged into `createApiClient`'s return value by `client.ts`. */
export function p5ClientMethods(call: Caller) {
  const v =
    <T>(schema: z.ZodType<T>) =>
    async (method: HttpMethod, path: string, body?: unknown): Promise<T> =>
      schema.parse(await call<unknown>(method, path, body));
  return {
    // usage & budgets (F19)
    usageGet: () => v(UsageSnapshotSchema)('GET', '/api/usage'),
    usageBudgets: () => v(z.array(BudgetStatusSchema))('GET', '/api/usage/budgets'),
    usageBudgetUpsert: (body: BudgetUpsertInput) => v(BudgetSchema)('PUT', '/api/usage/budgets', body),
    usageBudgetDelete: (id: string) => v(OkSchema)('DELETE', `/api/usage/budgets/${enc(id)}`),
    usageConcurrency: () => v(z.array(ConcurrencyStatusSchema))('GET', '/api/usage/concurrency'),
    usageContext: (source: string, id: string) =>
      v(ContextFillInfoSchema.nullable())('GET', `/api/usage/context/${enc(source)}/${enc(id)}`),
    // settings
    settingsGet: () => v(SettingsSchema)('GET', '/api/settings'),
    settingsUpdate: (body: SettingsUpdateBody) => v(SettingsSchema)('PUT', '/api/settings', body),
    // analytics (F7)
    analyticsCost: (q: AnalyticsCostQuery) =>
      v(CostResponseSchema)('GET', withQuery('/api/analytics/cost', q)),
    analyticsTop: (q: AnalyticsTopQuery) => v(TopResultSchema)('GET', withQuery('/api/analytics/top', q)),
    analyticsTools: (q: AnalyticsBucketQuery) =>
      v(z.array(ToolUsageRowSchema))('GET', withQuery('/api/analytics/tools', q)),
    analyticsTiming: (q: AnalyticsBucketQuery) =>
      v(TimingResultSchema)('GET', withQuery('/api/analytics/timing', q)),
    analyticsOutcomes: (q: { from?: string; to?: string; projectId?: string }) =>
      v(OutcomesResultSchema)('GET', withQuery('/api/analytics/outcomes', q)),
    analyticsWstack: (q: { from?: string; to?: string }) =>
      v(z.array(WstackSkillRowSchema))('GET', withQuery('/api/analytics/wstack', q)),
    analyticsDigestLatest: () => v(DigestRecordSchema.nullable())('GET', '/api/analytics/digest'),
    analyticsDigestGenerate: (weekStart?: string) =>
      v(DigestRecordSchema)('POST', '/api/analytics/digest', weekStart ? { weekStart } : {}),
    // streams (F6)
    streamsList: (q: { projectId?: string; stage?: StreamStage }) =>
      v(z.array(WorkStreamSchema))('GET', withQuery('/api/streams', q)),
    streamsRefresh: () => v(z.array(WorkStreamSchema))('POST', '/api/streams/refresh', {}),
    streamsGet: (ticket: string) => v(StreamDetailSchema)('GET', `/api/streams/${enc(ticket)}`),
    streamsLink: (ticket: string, body: { kind: StreamLinkKind; ref: string }) =>
      v(StreamLinkSchema)('POST', `/api/streams/${enc(ticket)}/link`, body),
    streamsUnlink: (ticket: string, body: { kind: StreamLinkKind; ref: string }) =>
      v(StreamLinkSchema)('POST', `/api/streams/${enc(ticket)}/unlink`, body),
    // recaps (F14)
    recapsGetSession: (source: string, id: string) =>
      v(RecapSchema.nullable())('GET', `/api/recaps/session/${enc(source)}/${enc(id)}`),
    recapsRunSession: (source: string, id: string, onDemand = true) =>
      v(RecapRunResponseSchema)('POST', `/api/recaps/session/${enc(source)}/${enc(id)}`, { onDemand }),
    recapsGetDaily: (projectId: string, date: string) =>
      v(RecapSchema.nullable())('GET', withQuery('/api/recaps/daily', { projectId, date })),
    recapsRunDaily: (projectId: string, date: string) =>
      v(z.object({ text: z.string() }))('POST', '/api/recaps/daily', { projectId, date }),
    recapsSpend: () => v(RecapSpendSchema)('GET', '/api/recaps/spend'),
    // goals, handoffs, reminders (F16)
    goalsList: (states?: GoalState[]) =>
      v(z.array(GoalSchema))('GET', withQuery('/api/goals', { state: states?.join(',') })),
    goalsGet: (targetType: 'session' | 'stream', targetId: string) =>
      v(GoalWithPrefillSchema)('GET', `/api/goals/${targetType}/${enc(targetId)}`),
    goalsSet: (targetType: 'session' | 'stream', targetId: string, body: GoalPutBody) =>
      v(GoalSchema)('PUT', `/api/goals/${targetType}/${enc(targetId)}`, body),
    handoffsLatest: (source: string, id: string) =>
      v(HandoffWithMarkdownSchema.nullable())('GET', `/api/handoffs/session/${enc(source)}/${enc(id)}`),
    handoffsGenerate: (source: string, id: string) =>
      v(HandoffSchema)('POST', `/api/handoffs/session/${enc(source)}/${enc(id)}`, {}),
    handoffsResumeFresh: (handoffId: string) =>
      v(ResumeFreshResponseSchema)('POST', `/api/handoffs/${enc(handoffId)}/resume-fresh`, { confirm: true }),
    remindersList: (q: { state?: ReminderState[]; sessionPk?: string }) =>
      v(z.array(ReminderSchema))(
        'GET',
        withQuery('/api/reminders', { state: q.state?.join(','), sessionPk: q.sessionPk }),
      ),
    remindersCreate: (body: ReminderCreateBody) => v(ReminderSchema)('POST', '/api/reminders', body),
    remindersCancel: (id: string) => v(ReminderSchema)('POST', `/api/reminders/${enc(id)}/cancel`, {}),
    // bridge (F10)
    hooksInstallStatus: () => v(HookInstallStatusSchema)('GET', '/api/hooks/install'),
    hooksInstall: () => v(HookInstallResultSchema)('POST', '/api/hooks/install', { confirm: true }),
    hooksStatusline: () => v(StatuslineSnippetSchema)('GET', '/api/hooks/statusline'),
  };
}

export type P5ClientMethods = ReturnType<typeof p5ClientMethods>;
