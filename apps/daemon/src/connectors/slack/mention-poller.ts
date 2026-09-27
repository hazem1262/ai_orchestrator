import { redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getConnectorMeta, setConnectorCursor, setConnectorStatus } from '../../db/repos/connectors.ts';
import { ConnectorError } from '../errors.ts';
import type { PollerHandle } from '../linear/assigned-poller.ts';
import type { SlackConnector } from './slack.ts';
import { slackTsFromDate } from './text.ts';

export function createSlackMentionPoller(d: {
  ctx: DaemonContext;
  slack: SlackConnector;
  now?: () => Date;
}): PollerHandle {
  const { ctx } = d;
  const now = () => (d.now ? d.now() : new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const meta = getConnectorMeta(ctx.db, 'slack');
      if (!ctx.config().connectors.slack.enabled || !meta) return;
      const since = typeof meta.cursor.mentionsSinceTs === 'string' ? meta.cursor.mentionsSinceTs : null;
      if (since === null) {
        setConnectorCursor(ctx.db, 'slack', { ...meta.cursor, mentionsSinceTs: slackTsFromDate(now()) });
        return;
      }
      let found: Array<{ channel: string; ts: string; text: string }>;
      try {
        found = await d.slack.mentions(since);
      } catch (e) {
        const status =
          e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
        setConnectorStatus(ctx.db, 'slack', status, now().toISOString());
        ctx.log.warn({ err: String(e) }, 'slack mention poll failed');
        return;
      }
      setConnectorStatus(ctx.db, 'slack', 'ok', now().toISOString());
      let cursor = since;
      for (const m of found) {
        ctx.bus.emit({ type: 'slack.mention', channel: m.channel, ts: m.ts, text: redact(m.text) });
        cursor = m.ts;
      }
      if (cursor !== since) setConnectorCursor(ctx.db, 'slack', { ...meta.cursor, mentionsSinceTs: cursor });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), ctx.config().connectors.slack.pollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
