import { eq } from 'drizzle-orm';
import type { DaemonContext } from '../context.ts';
import { getConnectorMeta } from '../db/repos/connectors.ts';
import { streams } from '../db/schema.ts';
import { need } from '../http/p6-util.ts';
import type { PollerHandle } from './linear/assigned-poller.ts';
import type { LinearConnector } from './linear/linear.ts';

export interface StreamTitleStore {
  list(): Array<{ ticket: string; title: string | null }>;
  setTitle(ticket: string, title: string): void;
}

export function createStreamTitleStore(ctx: DaemonContext): StreamTitleStore {
  return {
    list: () =>
      need(ctx.streams, 'streams')
        .list({})
        .map((s) => ({ ticket: s.ticket, title: s.title })),
    setTitle: (ticket, title) => {
      ctx.db.update(streams).set({ title }).where(eq(streams.ticket, ticket)).run();
    },
  };
}

export function createStreamEnricher(d: {
  ctx: DaemonContext;
  linear: LinearConnector;
  store: StreamTitleStore;
  maxPerTick?: number;
  intervalMs?: number;
}): PollerHandle {
  const max = d.maxPerTick ?? 20;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!d.ctx.config().connectors.linear.enabled || !getConnectorMeta(d.ctx.db, 'linear')) return;
      const missing = d.store
        .list()
        .filter((s) => s.title === null)
        .slice(0, max);
      for (const s of missing) {
        try {
          const issue = await d.linear.issue(s.ticket);
          if (issue) d.store.setTitle(s.ticket, issue.title);
        } catch (err) {
          d.ctx.log.warn({ err: String(err), ticket: s.ticket }, 'stream enrichment failed');
          return;
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), d.intervalMs ?? 5 * 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
