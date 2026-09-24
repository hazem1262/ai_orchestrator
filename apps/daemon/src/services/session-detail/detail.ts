import type { SessionSafety, SessionStatsResponse, UsagePoint } from '@orc/api-contract';
import {
  computeSessionStats,
  computeTurnStats,
  deliverablesByTurn,
  detectProdTouches,
  extractFileChanges,
  type FileSummary,
  permissionBadge,
  type Session,
  type Source,
  summarizeFiles,
  type TimelineEvent,
  type TurnDeliverables,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { collectEvents } from './collect.ts';

export interface SessionEventsBundle {
  session: Session;
  main: TimelineEvent[];
  agents: Array<{ agentId: string; events: TimelineEvent[] }>;
}

export interface SessionDetailService {
  bundle(source: Source, id: string): SessionEventsBundle | null;
  stats(source: Source, id: string): SessionStatsResponse | null;
  deliverables(source: Source, id: string): TurnDeliverables[] | null;
  files(source: Source, id: string): FileSummary[] | null;
  usageSeries(source: Source, id: string): UsagePoint[] | null;
  safety(source: Source, id: string): SessionSafety | null;
}

const CACHE_SIZE = 20;

export function costWeight(p: Pick<UsagePoint, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return p.input + 5 * p.output + 1.25 * p.cacheWrite + 0.1 * p.cacheRead;
}

/** Splits the session's cost-state total across usage points by token weight (see the note above). */
export function apportionCost(points: UsagePoint[], totalUsd: number | null): UsagePoint[] {
  if (totalUsd === null) return points;
  const total = points.reduce((sum, p) => sum + costWeight(p), 0);
  return points.map((p) => ({ ...p, costUsd: total > 0 ? (totalUsd * costWeight(p)) / total : 0 }));
}

export function createSessionDetailService(
  ctx: Pick<DaemonContext, 'sessions' | 'projects' | 'config'>,
): SessionDetailService {
  const cache = new Map<string, { key: string; bundle: SessionEventsBundle }>();

  function bundle(source: Source, id: string): SessionEventsBundle | null {
    const session = ctx.sessions.get(source, id);
    if (!session) return null;
    const agents = ctx.sessions.agents(source, id);
    const key = `${session.lastActivityAt}|${agents.map((a) => `${a.id}:${a.endedAt ?? 'running'}`).join(',')}`;
    const pk = `${source}:${id}`;
    const hit = cache.get(pk);
    if (hit && hit.key === key) return hit.bundle;
    const b: SessionEventsBundle = {
      session,
      main: collectEvents(ctx.sessions, source, id, null),
      agents: agents.map((a) => ({ agentId: a.id, events: collectEvents(ctx.sessions, source, id, a.id) })),
    };
    cache.delete(pk);
    cache.set(pk, { key, bundle: b });
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return b;
  }

  const allEvents = (b: SessionEventsBundle) => [...b.main, ...b.agents.flatMap((a) => a.events)];

  return {
    bundle,
    stats(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const turns = computeTurnStats(b.main);
      return {
        session: computeSessionStats(turns),
        turns,
        agents: b.agents.map((a) => ({
          agentId: a.agentId,
          stats: computeSessionStats(computeTurnStats(a.events)),
        })),
      };
    },
    deliverables(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      return [...deliverablesByTurn(b.main), ...b.agents.flatMap((a) => deliverablesByTurn(a.events))];
    },
    files(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      return summarizeFiles([
        ...extractFileChanges(b.main),
        ...b.agents.flatMap((a) => extractFileChanges(a.events)),
      ]);
    },
    usageSeries(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const points: UsagePoint[] = [];
      for (const e of allEvents(b)) {
        if (!e.usage || !e.model || e.model === '<synthetic>') continue;
        points.push({
          ts: e.ts,
          agentId: e.agentId,
          model: e.model,
          input: e.usage.input,
          output: e.usage.output,
          cacheRead: e.usage.cacheRead,
          cacheWrite: e.usage.cacheWrite,
          costUsd: null,
        });
      }
      points.sort((a, c) => (a.ts < c.ts ? -1 : a.ts > c.ts ? 1 : 0));
      return apportionCost(points, b.session.usage.costUsd);
    },
    safety(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const project = b.session.projectId ? ctx.projects.get(b.session.projectId) : null;
      const opts = { prodSkills: ctx.config().safety.prodSkills, prodPatterns: project?.prodPatterns ?? [] };
      const prodTouches = [
        ...detectProdTouches(b.main, opts),
        ...b.agents.flatMap((a) => detectProdTouches(a.events, opts)),
      ];
      return {
        permissionMode: b.session.permissionMode,
        permissionBadge: permissionBadge([b.session.permissionMode]),
        touchedProd: b.session.flags.touchedProd || prodTouches.length > 0,
        prodTouches,
      };
    },
  };
}
