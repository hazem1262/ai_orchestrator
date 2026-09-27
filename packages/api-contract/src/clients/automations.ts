import { z } from 'zod';
import {
  Automation,
  type AutomationInput,
  AutomationRunDetail,
  type AutomationRunRequest,
  AutomationSettings,
  type AutomationSettingsPatch,
  AutomationWithStats,
  Suggestion,
} from '../routes/automations.ts';
import type { ApiCall } from './phase7.ts';

export interface AutomationsApi {
  automationsList(): Promise<AutomationWithStats[]>;
  automationsGet(id: string): Promise<AutomationWithStats>;
  automationsSave(a: AutomationInput): Promise<Automation>;
  /** `confirm` defaults to true; send false first to get the daemon's `409 confirmation_required` summary. */
  automationsDelete(id: string, confirm?: boolean): Promise<{ ok: true }>;
  automationsSetEnabled(id: string, enabled: boolean): Promise<Automation>;
  automationsRun(id: string, vars?: AutomationRunRequest['vars']): Promise<AutomationRunDetail>;
  automationsRuns(id: string): Promise<AutomationRunDetail[]>;
  automationsRunGet(runId: string): Promise<AutomationRunDetail>;
  automationsRunLog(runId: string): Promise<{ lines: string[] }>;
  automationsApprove(runId: string, confirm?: boolean): Promise<AutomationRunDetail>;
  automationsReject(runId: string): Promise<AutomationRunDetail>;
  automationsRerun(runId: string): Promise<AutomationRunDetail | { deduped: true }>;
  automationsSettingsGet(): Promise<AutomationSettings>;
  automationsSettings(patch: AutomationSettingsPatch): Promise<AutomationSettings>;
  suggestionsList(state?: Suggestion['state']): Promise<Suggestion[]>;
  suggestionsRefresh(): Promise<{ added: number }>;
  suggestionsAccept(id: string, confirm?: boolean): Promise<{ ptyId: string; sessionPk: string | null }>;
  suggestionsDismiss(id: string): Promise<Suggestion>;
}

const Ok = z.object({ ok: z.literal(true) });
const RunLog = z.object({ lines: z.array(z.string()) });
const Added = z.object({ added: z.number().int() });
const Accepted = z.object({ ptyId: z.string(), sessionPk: z.string().nullable() });
const RerunResult = z.union([AutomationRunDetail, z.object({ deduped: z.literal(true) })]);

export function automationsClient(call: ApiCall): AutomationsApi {
  const a = (id: string) => `/api/automations/${encodeURIComponent(id)}`;
  const r = (runId: string) => `/api/automations/runs/${encodeURIComponent(runId)}`;
  const s = (id: string) => `/api/automations/suggestions/${encodeURIComponent(id)}`;
  return {
    automationsList: () => call(z.array(AutomationWithStats), 'GET', '/api/automations'),
    automationsGet: (id) => call(AutomationWithStats, 'GET', a(id)),
    automationsSave: (body) => call(Automation, 'POST', '/api/automations', body),
    automationsDelete: (id, confirm = true) => call(Ok, 'DELETE', a(id), { confirm }),
    automationsSetEnabled: (id, enabled) => call(Automation, 'POST', `${a(id)}/enabled`, { enabled }),
    automationsRun: (id, vars) => call(AutomationRunDetail, 'POST', `${a(id)}/run`, vars ? { vars } : {}),
    automationsRuns: (id) => call(z.array(AutomationRunDetail), 'GET', `${a(id)}/runs`),
    automationsRunGet: (runId) => call(AutomationRunDetail, 'GET', r(runId)),
    automationsRunLog: (runId) => call(RunLog, 'GET', `${r(runId)}/log`),
    automationsApprove: (runId, confirm = true) =>
      call(AutomationRunDetail, 'POST', `${r(runId)}/approve`, { confirm }),
    automationsReject: (runId) => call(AutomationRunDetail, 'POST', `${r(runId)}/reject`, {}),
    automationsRerun: (runId) => call(RerunResult, 'POST', `${r(runId)}/rerun`, {}),
    automationsSettingsGet: () => call(AutomationSettings, 'GET', '/api/automations/settings'),
    automationsSettings: (patch) => call(AutomationSettings, 'PATCH', '/api/automations/settings', patch),
    suggestionsList: (state) =>
      call(z.array(Suggestion), 'GET', `/api/automations/suggestions${state ? `?state=${state}` : ''}`),
    suggestionsRefresh: () => call(Added, 'POST', '/api/automations/suggestions/refresh', {}),
    suggestionsAccept: (id, confirm = true) => call(Accepted, 'POST', `${s(id)}/accept`, { confirm }),
    suggestionsDismiss: (id) => call(Suggestion, 'POST', `${s(id)}/dismiss`, {}),
  };
}
