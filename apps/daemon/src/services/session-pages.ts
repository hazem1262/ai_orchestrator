import type { Session, TimelineEvent } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import type { SessionListItem, SessionListQuery } from './sessions.ts';

/** Pages through SessionService.list until exhausted (or `max` items). */
export function listAllSessions(
  ctx: DaemonContext,
  q: Omit<SessionListQuery, 'cursor' | 'limit'>,
  max = 5000,
): SessionListItem[] {
  const out: SessionListItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ctx.sessions.list({ ...q, limit: 200, cursor });
    out.push(...page.items);
    if (page.nextCursor === null || out.length >= max) break;
    cursor = page.nextCursor;
  }
  return out.slice(0, max);
}

/** Loads events for one transcript (agentId null = main) in seq order, capped at `max`. */
export function loadEvents(
  ctx: DaemonContext,
  s: Pick<Session, 'source' | 'id'>,
  agentId: string | null,
  max = 20000,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = ctx.sessions.events(s.source, s.id, { agentId, afterSeq, limit: 500 });
    out.push(...page.items);
    const last = page.items.at(-1);
    if (page.nextSeq === null || last === undefined || out.length >= max) break;
    afterSeq = last.seq;
  }
  return out.slice(0, max);
}
