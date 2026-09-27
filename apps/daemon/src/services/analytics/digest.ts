import { type DigestRecord, extractTicketsFrom, renderWeeklyDigest } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { latestDigest, upsertDigest } from '../../db/repos/digests.ts';
import type { PrSource } from '../pr-source.ts';
import { ensureCronJob, removeJobsOfType, type Scheduler } from '../scheduler/scheduler.ts';
import type { UsageMeter } from '../usage/meter.ts';
import type { AnalyticsService } from './analytics.ts';

export interface DigestService {
  generate(weekStart?: string): Promise<DigestRecord>;
  latest(): DigestRecord | null;
  syncSchedule(): void;
  start(): void;
  stop(): void;
}

const DAY = 86_400_000;
const STUCK_MS = 30 * 60_000;
const STUCK_STATUSES = new Set(['waiting', 'blocked', 'error']);

/** Monday (UTC) of the ISO week before `now`, as YYYY-MM-DD. */
export function lastWeekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

export function createDigestService(
  ctx: DaemonContext,
  deps: {
    analytics: AnalyticsService;
    prs: PrSource;
    meter: UsageMeter;
    scheduler: Scheduler;
    now?: () => Date;
  },
): DigestService {
  const now = deps.now ?? (() => new Date());
  const unsubs: Array<() => void> = [];

  async function generate(weekStart?: string): Promise<DigestRecord> {
    const start = weekStart ?? lastWeekStart(now());
    const fromMs = Date.parse(`${start}T00:00:00.000Z`);
    const from = new Date(fromMs).toISOString();
    const to = new Date(fromMs + 7 * DAY - 1).toISOString();
    const byProject = deps.analytics.cost({ from, to, groupBy: 'project' });
    const pattern = ctx.config().projects.find((p) => p.features.workStreams)?.ticketRegex ?? null;
    const at = now().getTime();
    const markdown = renderWeeklyDigest({
      weekStart: start,
      weekEnd: to.slice(0, 10),
      spendUsd: byProject.rows.reduce((a, r) => a + r.costUsd, 0),
      estimated: byProject.estimated,
      spendByProject: byProject.rows,
      shippedPrs: deps.prs
        .list()
        .filter(
          (p) =>
            p.state === 'merged' &&
            !p.isBackmerge &&
            p.mergedAt !== null &&
            p.mergedAt >= from &&
            p.mergedAt <= to,
        )
        .map((p) => ({
          title: p.title,
          url: p.pr.url,
          number: p.pr.number,
          mergedAt: p.mergedAt ?? p.updatedAt,
          tickets: extractTicketsFrom(`${p.title} ${p.headRef ?? ''}`, pattern),
        })),
      stuckSessions: (ctx.live?.list() ?? [])
        .filter(
          (s) =>
            s.live !== null && STUCK_STATUSES.has(s.live.status) && at - Date.parse(s.live.since) >= STUCK_MS,
        )
        .map((s) => ({
          pk: `${s.source}:${s.id}`,
          name: s.name,
          status: s.live?.status ?? 'unknown',
          since: s.live?.since ?? s.lastActivityAt,
        })),
      topTickets: deps.analytics.top({ from, to, limit: 5 }).tickets,
      quota: deps.meter.snapshot(),
      budgets: deps.meter.budgets(),
    });
    const record: DigestRecord = { weekStart: start, markdown, createdAt: now().toISOString() };
    upsertDigest(ctx.db, record);
    return record;
  }

  function syncSchedule(): void {
    const cfg = ctx.config().digest;
    if (cfg.enabled) ensureCronJob(deps.scheduler, 'digest', 'weekly_digest', cfg.cron);
    else removeJobsOfType(deps.scheduler, 'digest', 'weekly_digest');
  }

  return {
    generate,
    latest: () => latestDigest(ctx.db),
    syncSchedule,
    start() {
      deps.scheduler.onFire('digest', async (job) => {
        if (job.payload.type === 'weekly_digest') await generate();
      });
      syncSchedule();
      unsubs.push(ctx.bus.on('config.changed', syncSchedule));
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
    },
  };
}
