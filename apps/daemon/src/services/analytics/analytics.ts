import {
  type AnalyticsEntry,
  type AnalyticsGroupBy,
  type CostRow,
  costPerMergedPr,
  groupCost,
  type OutcomesResult,
  summarizeFacets,
  summarizeWstackTimeline,
  type TimingResult,
  type ToolUsageRow,
  type TopResult,
  timingSummary,
  toolUsageRows,
  topSessionCosts,
  topTickets,
  type WstackSkillRow,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { LedgerEntry } from '../../db/repos/usage-ledger.ts';
import type { PrSource } from '../pr-source.ts';
import { listAllSessions } from '../session-pages.ts';
import type { UsageLedger } from '../usage/ledger.ts';
import { readWstackTimelines, resolveWstackHome } from '../wstack.ts';
import { readFacets } from './facets.ts';

export interface AnalyticsQuery {
  from: string;
  to: string;
  projectId?: string;
}

export function resolveRange(
  q: { from?: string; to?: string; projectId?: string },
  now: Date,
): AnalyticsQuery {
  const out: AnalyticsQuery = {
    from: q.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    to: q.to ?? now.toISOString(),
  };
  if (q.projectId !== undefined) out.projectId = q.projectId;
  return out;
}

export interface AnalyticsService {
  cost(q: AnalyticsQuery & { groupBy: AnalyticsGroupBy }): { rows: CostRow[]; estimated: boolean };
  top(q: AnalyticsQuery & { limit: number }): TopResult;
  tools(q: AnalyticsQuery & { bucket: 'day' | 'week' }): ToolUsageRow[];
  timing(q: AnalyticsQuery & { bucket: 'day' | 'week' }): TimingResult;
  outcomes(q: AnalyticsQuery): OutcomesResult;
  wstack(q: AnalyticsQuery): WstackSkillRow[];
}

const toAnalytics = (e: LedgerEntry): AnalyticsEntry => ({
  sessionPk: e.sessionPk,
  ts: e.ts,
  source: e.source,
  projectId: e.projectId,
  tickets: e.tickets,
  model: e.model,
  input: e.input,
  output: e.output,
  cacheRead: e.cacheRead,
  cacheWrite: e.cacheWrite,
  costUsd: e.allocCostUsd,
  latencyMs: e.latencyMs,
});

export function createAnalyticsService(
  ctx: DaemonContext,
  deps: { ledger: UsageLedger; prs: PrSource },
): AnalyticsService {
  const range = (q: AnalyticsQuery) => ({
    from: q.from,
    to: q.to,
    ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
  });
  const entries = (q: AnalyticsQuery) => deps.ledger.entries(range(q));
  const tools = (q: AnalyticsQuery) =>
    deps.ledger
      .tools(range(q))
      .map((t) => ({ ts: t.ts, kind: t.kind, name: t.name, durationMs: t.durationMs }));

  return {
    cost(q) {
      const rows = entries(q);
      return {
        rows: groupCost(rows.map(toAnalytics), q.groupBy),
        estimated: rows.some((r) => !r.authoritative),
      };
    },
    top(q) {
      const rows = entries(q).map(toAnalytics);
      const sessions = topSessionCosts(rows, q.limit).map(({ pk, costUsd }) => {
        const s = ctx.sessions.getByPk(pk);
        return {
          pk,
          name: s?.name ?? null,
          projectId: s?.projectId ?? null,
          costUsd,
          tickets: s?.tickets ?? [],
        };
      });
      const merged = deps.prs
        .list()
        .filter(
          (p) => p.state === 'merged' && p.mergedAt !== null && p.mergedAt >= q.from && p.mergedAt <= q.to,
        );
      const allTime = deps.ledger.entries({
        from: '1970-01-01T00:00:00.000Z',
        to: q.to,
        ...(q.projectId ? { projectId: q.projectId } : {}),
      });
      const prSessions = merged.map((p) => listAllSessions(ctx, { pr: p.pr.url }).map((s) => s.pk));
      return {
        sessions,
        tickets: topTickets(rows, q.limit),
        ...costPerMergedPr(allTime.map(toAnalytics), prSessions),
      };
    },
    tools: (q) => toolUsageRows(tools(q), q.bucket),
    timing: (q) => timingSummary(entries(q).map(toAnalytics), tools(q), q.bucket),
    outcomes(q) {
      const ids = new Set(
        entries(q)
          .filter((e) => e.sessionPk.startsWith('claude:'))
          .map((e) => e.sessionPk.slice('claude:'.length)),
      );
      return summarizeFacets(readFacets(ctx.paths.claudeHome), ids);
    },
    wstack: (q) => summarizeWstackTimeline(readWstackTimelines(resolveWstackHome()), q.from, q.to),
  };
}
