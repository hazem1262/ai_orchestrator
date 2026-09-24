import type { Source, TimelineEvent } from '@orc/core';
import type { SessionService } from '../sessions.ts';

const PAGE = 1000;
const MAX_EVENTS = 200_000;

export function collectEvents(
  sessions: Pick<SessionService, 'events'>,
  source: Source,
  id: string,
  agentId: string | null,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = sessions.events(source, id, { agentId, afterSeq, limit: PAGE });
    for (const e of page.items) out.push(e);
    if (page.nextSeq === null || page.items.length === 0 || out.length >= MAX_EVENTS) break;
    afterSeq = page.nextSeq;
  }
  return out;
}
