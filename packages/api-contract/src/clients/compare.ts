import { toQueryString } from '../client.ts';
import {
  ArchiveLosersResult,
  CompareEstimate,
  CompareGroup,
  CompareView,
  PickWinnerResult,
} from '../routes/compare.ts';
import type { LaunchRequestInput } from '../routes/launch.ts';
import type { ApiCall } from './phase7.ts';

export interface CompareApi {
  compareLaunch(req: LaunchRequestInput): Promise<CompareGroup>;
  compareEstimate(projectId: string | null, n: number): Promise<CompareEstimate>;
  compareGet(groupId: string): Promise<CompareView>;
  comparePickWinner(groupId: string, index: number): Promise<PickWinnerResult>;
  compareArchiveLosers(groupId: string): Promise<ArchiveLosersResult>;
}

export function compareClient(call: ApiCall): CompareApi {
  const g = (id: string) => `/api/compare/${encodeURIComponent(id)}`;
  return {
    compareLaunch: (req) => call(CompareGroup, 'POST', '/api/compare', req),
    compareEstimate: (projectId, n) =>
      call(CompareEstimate, 'GET', `/api/compare/estimate${toQueryString({ projectId, n })}`),
    compareGet: (id) => call(CompareView, 'GET', g(id)),
    comparePickWinner: (id, index) => call(PickWinnerResult, 'POST', `${g(id)}/winner`, { index }),
    compareArchiveLosers: (id) =>
      call(ArchiveLosersResult, 'POST', `${g(id)}/archive-losers`, { confirm: true }),
  };
}
