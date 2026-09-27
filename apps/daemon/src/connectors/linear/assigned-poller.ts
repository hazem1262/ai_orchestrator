import type { LinearIssue } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { getConnectorMeta, setConnectorCursor, setConnectorStatus } from '../../db/repos/connectors.ts';
import { ConnectorError } from '../errors.ts';
import type { LinearConnector } from './linear.ts';

export interface PollerHandle {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

type Seen = Record<string, { fp: string; issue: LinearIssue }>;

const fingerprint = (i: LinearIssue) => JSON.stringify([i.title, i.state, i.assignee, [...i.labels].sort()]);

export function createLinearAssignedPoller(d: {
  ctx: DaemonContext;
  linear: LinearConnector;
  now?: () => Date;
}): PollerHandle {
  const { ctx } = d;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const meta = getConnectorMeta(ctx.db, 'linear');
      if (!ctx.config().connectors.linear.enabled || !meta) return;
      const at = (d.now ? d.now() : new Date()).toISOString();
      let issues: LinearIssue[];
      try {
        issues = await d.linear.assignedToMe();
      } catch (e) {
        const status =
          e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
        setConnectorStatus(ctx.db, 'linear', status, at);
        ctx.log.warn({ err: String(e) }, 'linear assigned-to-me poll failed');
        return;
      }
      setConnectorStatus(ctx.db, 'linear', 'ok', at);
      const prev = (meta.cursor.assigned ?? null) as Seen | null;
      const next: Seen = {};
      for (const issue of issues) {
        const fp = fingerprint(issue);
        next[issue.id] = { fp, issue };
        if (prev === null) continue;
        const before = prev[issue.id];
        if (!before) ctx.bus.emit({ type: 'linear.issueChanged', before: null, after: issue });
        else if (before.fp !== fp)
          ctx.bus.emit({ type: 'linear.issueChanged', before: before.issue, after: issue });
      }
      setConnectorCursor(ctx.db, 'linear', { ...meta.cursor, assigned: next });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), ctx.config().connectors.linear.pollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
