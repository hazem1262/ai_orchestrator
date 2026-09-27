import { extractTicketsFrom, type Goal, type GoalState, truncateText } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getGoal, goalSource, listGoals, upsertGoal } from '../../db/repos/goals.ts';
import { listAllSessions } from '../session-pages.ts';

export const NEEDS_ANSWER = 'needs answer';
export const WAITING_BLOCK_MS = 30 * 60_000;

export interface GoalService {
  get(targetType: Goal['targetType'], targetId: string): Goal | null;
  set(g: Omit<Goal, 'id' | 'updatedAt'>): Goal;
  list(filter: { state?: GoalState[] }): Goal[];
  prefill(targetType: Goal['targetType'], targetId: string): string;
  sweep(now?: Date): number;
  start(): void;
  stop(): void;
}

export function createGoalService(
  ctx: DaemonContext,
  opts: { now?: () => Date; sweepMs?: number } = {},
): GoalService {
  const now = opts.now ?? (() => new Date());
  const waitingSince = new Map<string, number>();
  const unsubs: Array<() => void> = [];
  let timer: NodeJS.Timeout | null = null;

  const iso = () => now().toISOString();
  const streamTitle = (ticket: string) =>
    ctx.streams?.list({}).find((s) => s.ticket === ticket)?.title ?? null;

  function prefill(targetType: Goal['targetType'], targetId: string): string {
    if (targetType === 'stream') {
      const title = streamTitle(targetId);
      return title ? `${targetId}: ${title}` : targetId;
    }
    const s = ctx.sessions.getByPk(targetId);
    if (!s) return '';
    const ticket = s.tickets[0];
    const title = ticket ? streamTitle(ticket) : null;
    if (ticket && title) return `${ticket}: ${title}`;
    return truncateText((s.firstPrompt ?? s.name ?? '').trim(), 200);
  }

  function fromRule(
    targetType: Goal['targetType'],
    targetId: string,
    state: GoalState,
    reason: string | null,
  ): Goal {
    const g = getGoal(ctx.db, targetType, targetId);
    return upsertGoal(
      ctx.db,
      {
        targetType,
        targetId,
        objective: g?.objective ?? prefill(targetType, targetId),
        state,
        blockedReason: reason,
      },
      'rule',
      iso(),
    );
  }

  function sweep(at: Date = now()): number {
    let changed = 0;
    for (const [pk, since] of waitingSince) {
      if (at.getTime() - since < WAITING_BLOCK_MS) continue;
      const g = getGoal(ctx.db, 'session', pk);
      if (g === null || g.state === 'active') {
        fromRule('session', pk, 'blocked', NEEDS_ANSWER);
        changed++;
      }
    }
    return changed;
  }

  function onPrMerged(url: string, title: string, headRef: string | null): void {
    for (const s of listAllSessions(ctx, { pr: url })) {
      const g = getGoal(ctx.db, 'session', s.pk);
      if (g && g.state !== 'complete') fromRule('session', s.pk, 'complete', null);
    }
    const pattern = ctx.config().projects.find((p) => p.features.workStreams)?.ticketRegex ?? null;
    for (const ticket of extractTicketsFrom(`${title} ${headRef ?? ''}`, pattern)) {
      const g = getGoal(ctx.db, 'stream', ticket);
      if (g && g.state !== 'complete') fromRule('stream', ticket, 'complete', null);
    }
  }

  return {
    get: (t, id) => getGoal(ctx.db, t, id),
    set: (g) => upsertGoal(ctx.db, g, 'manual', iso()),
    list: (f) => listGoals(ctx.db, f.state),
    prefill,
    sweep,
    start() {
      if (timer) return;
      unsubs.push(
        ctx.bus.on('session.statusChanged', (e) => {
          if (e.to === 'waiting') {
            if (!waitingSince.has(e.pk)) waitingSince.set(e.pk, now().getTime());
            return;
          }
          waitingSince.delete(e.pk);
          const g = getGoal(ctx.db, 'session', e.pk);
          if (
            g &&
            g.state === 'blocked' &&
            g.blockedReason === NEEDS_ANSWER &&
            goalSource(ctx.db, g.id) === 'rule'
          ) {
            fromRule('session', e.pk, 'active', null);
          }
        }),
        ctx.bus.on('pr.changed', (e) => {
          if (e.after.state === 'merged' && e.before?.state !== 'merged') {
            onPrMerged(e.after.pr.url, e.after.title, e.after.headRef);
          }
        }),
      );
      timer = setInterval(() => sweep(), opts.sweepMs ?? 60_000);
      timer.unref?.();
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
