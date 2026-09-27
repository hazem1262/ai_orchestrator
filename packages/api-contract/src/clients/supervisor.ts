import { z } from 'zod';
import { toQueryString } from '../client.ts';
import {
  SupervisorDecisionView,
  SupervisorRule,
  type SupervisorRuleInput,
  type SupervisorSettingsPatch,
  SupervisorStatus,
  SupervisorTarget,
} from '../routes/supervisor.ts';
import type { ApiCall } from './phase7.ts';

export interface SupervisorApi {
  supervisorStatus(): Promise<SupervisorStatus>;
  supervisorSettings(patch: SupervisorSettingsPatch): Promise<SupervisorStatus>;
  supervisorTargets(): Promise<SupervisorTarget[]>;
  supervisorSetTarget(t: SupervisorTarget): Promise<SupervisorTarget>;
  supervisorRules(): Promise<SupervisorRule[]>;
  supervisorAddRule(r: SupervisorRuleInput): Promise<SupervisorRule>;
  supervisorDeleteRule(id: string, confirm?: boolean): Promise<{ ok: true }>;
  supervisorDecisions(q?: { sessionPk?: string; limit?: number }): Promise<SupervisorDecisionView[]>;
  supervisorMarkWrong(decisionId: string): Promise<SupervisorRule>;
  supervisorEvaluate(source: string, id: string): Promise<SupervisorDecisionView>;
}

const Ok = z.object({ ok: z.literal(true) });

export function supervisorClient(call: ApiCall): SupervisorApi {
  const base = '/api/supervisor';
  return {
    supervisorStatus: () => call(SupervisorStatus, 'GET', `${base}/status`),
    supervisorSettings: (patch) => call(SupervisorStatus, 'PATCH', `${base}/settings`, patch),
    supervisorTargets: () => call(z.array(SupervisorTarget), 'GET', `${base}/targets`),
    supervisorSetTarget: (t) => call(SupervisorTarget, 'PUT', `${base}/targets`, t),
    supervisorRules: () => call(z.array(SupervisorRule), 'GET', `${base}/rules`),
    supervisorAddRule: (r) => call(SupervisorRule, 'POST', `${base}/rules`, r),
    supervisorDeleteRule: (id, confirm = true) =>
      call(Ok, 'DELETE', `${base}/rules/${encodeURIComponent(id)}`, { confirm }),
    supervisorDecisions: (q = {}) =>
      call(z.array(SupervisorDecisionView), 'GET', `${base}/decisions${toQueryString(q)}`),
    supervisorMarkWrong: (id) =>
      call(SupervisorRule, 'POST', `${base}/decisions/${encodeURIComponent(id)}/wrong`, {}),
    supervisorEvaluate: (source, id) =>
      call(
        SupervisorDecisionView,
        'POST',
        `${base}/evaluate/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
        {},
      ),
  };
}
