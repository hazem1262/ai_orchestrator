import { type InboxItem, type InboxState, redact } from '@orc/core';
import { ConnectorError } from '../../connectors/errors.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import { decodeSlackText } from '../../connectors/slack/text.ts';
import type { DaemonContext } from '../../context.ts';
import { getConnectorMeta } from '../../db/repos/connectors.ts';
import {
  getSlackThread,
  insertSlackThread,
  listOpenSlackThreads,
  type SlackThread,
  updateSlackThread,
} from '../../db/repos/slack-threads.ts';
import { need, type Who } from '../../http/p6-util.ts';
import { InboxError } from '../../inbox/engine.ts';
import { remoteUrl } from '../../notify/format.ts';
import { KIND_TITLE } from '../../notify/macos.ts';
import { ServiceError } from '../errors.ts';
import { inboxSessionPk, type SessionActions } from './session-actions.ts';

export const APPROVE_REACTION = 'white_check_mark';
export const SNOOZE_REACTION = 'zzz';
const ALL_STATES: InboxState[] = ['open', 'snoozed', 'done', 'auto_resolved'];
const MAX_APP_TS = 200;

export type BridgeCommand =
  | { kind: 'done' }
  | { kind: 'approve' }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'reply'; text: string };

export function parseBridgeCommand(text: string): BridgeCommand {
  const t = decodeSlackText(text).trim();
  if (/^!done$/i.test(t)) return { kind: 'done' };
  if (/^!approve$/i.test(t)) return { kind: 'approve' };
  const snooze = /^!snooze(?:\s+(\d{1,5}))?$/i.exec(t);
  if (snooze) return { kind: 'snooze', minutes: Math.min(1440, Math.max(1, Number(snooze[1] ?? 60))) };
  return { kind: 'reply', text: t };
}

/** Slack control characters: escaping them stops `<!channel>`, `<@U…>` and link markup. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatSlackItem(item: InboxItem, url: string, replyable: boolean): string {
  const meta = [item.projectId, item.ticket].filter((x): x is string => Boolean(x)).map(escapeSlack);
  const head = [`*${escapeSlack(KIND_TITLE[item.kind])}*`, ...meta].join(' · ');
  const help = replyable
    ? 'Reply in this thread to answer the session · react :white_check_mark: to approve · :zzz: to snooze 1h · `!done` · `!snooze 30`'
    : '_This session is not running in the app, so replies are off._ React :zzz: to snooze 1h · `!done`';
  return [head, escapeSlack(redact(item.reason)), `<${url}|Open in Orchestrator>`, help].join('\n');
}

export interface SlackBridge {
  ensureThread(item: InboxItem, url: string): Promise<void>;
  onInboxUpserted(item: InboxItem): Promise<void>;
  poll(): Promise<void>;
  start(): void;
  stop(): void;
}

function errorCode(e: unknown): string {
  if (e instanceof ServiceError || e instanceof ConnectorError || e instanceof InboxError) return e.code;
  return 'error';
}

export function createSlackBridge(d: {
  ctx: DaemonContext;
  slack: SlackConnector;
  actions: SessionActions;
  now?: () => Date;
}): SlackBridge {
  const { ctx } = d;
  const now = () => (d.now ? d.now() : new Date());
  const who: Who = { actor: 'remote', actorDetail: 'slack_dm' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let polling = false;

  const connected = () => ctx.config().connectors.slack.enabled && getConnectorMeta(ctx.db, 'slack') !== null;

  function isOwned(pk: string | null): boolean {
    if (!pk) return false;
    const live = ctx.sessions.getByPk(pk)?.live;
    return live?.ownership === 'owned' && live.ptyId !== null;
  }

  /** Posts in the item's thread and records the ts so the poll never reads it back as a command. */
  async function say(inboxItemId: string, text: string): Promise<void> {
    const t = getSlackThread(ctx.db, inboxItemId);
    if (!t) return;
    const { ts } = await d.slack.post(t.channel, text, t.rootTs);
    const latest = getSlackThread(ctx.db, inboxItemId) ?? t;
    updateSlackThread(
      ctx.db,
      inboxItemId,
      { appTs: [...latest.appTs, ts].slice(-MAX_APP_TS) },
      now().toISOString(),
    );
  }

  async function resolve(inboxItemId: string, state: InboxState): Promise<void> {
    const t = getSlackThread(ctx.db, inboxItemId);
    if (t?.state !== 'open') return;
    updateSlackThread(ctx.db, inboxItemId, { state: 'resolved' }, now().toISOString());
    await say(
      inboxItemId,
      `:heavy_check_mark: Resolved (${state === 'done' ? 'done' : 'condition cleared'}).`,
    );
  }

  async function run(t: SlackThread, item: InboxItem, cmd: BridgeCommand): Promise<void> {
    const inbox = need(ctx.inbox, 'inbox');
    try {
      switch (cmd.kind) {
        case 'done':
          inbox.markDone(item.id);
          return;
        case 'snooze': {
          const until = new Date(now().getTime() + cmd.minutes * 60_000).toISOString();
          inbox.snooze(item.id, until);
          await say(t.inboxItemId, `:zzz: Snoozed until ${until}.`);
          return;
        }
        case 'approve':
          await d.actions.approve({ itemId: item.id, ...who });
          return;
        case 'reply':
          if (!t.sessionPk) {
            await say(t.inboxItemId, ':x: Not done (no_session): this item has no session.');
            return;
          }
          await d.actions.reply({ pk: t.sessionPk, text: cmd.text, ...who });
          await say(t.inboxItemId, ':arrow_right: Sent to the session.');
          return;
      }
    } catch (e) {
      await say(
        t.inboxItemId,
        `:x: Not done (${errorCode(e)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function pollThread(t: SlackThread, item: InboxItem | null, myUserId: string): Promise<void> {
    if (!item || item.state === 'done' || item.state === 'auto_resolved') {
      await resolve(t.inboxItemId, item?.state ?? 'done');
      return;
    }
    const reactions = await d.slack.reactions(t.channel, t.rootTs);
    const done = new Set(t.reactionsDone);
    const byReaction: Array<[string, BridgeCommand]> = [
      [APPROVE_REACTION, { kind: 'approve' }],
      [SNOOZE_REACTION, { kind: 'snooze', minutes: 60 }],
    ];
    for (const [name, cmd] of byReaction) {
      if (!reactions.includes(name) || done.has(name)) continue;
      done.add(name);
      // Recorded before running, so a crash mid-command never runs it twice.
      updateSlackThread(ctx.db, t.inboxItemId, { reactionsDone: [...done] }, now().toISOString());
      await run(t, item, cmd);
    }
    const replies = await d.slack.replies(t.channel, t.rootTs, t.lastSeenTs);
    for (const m of replies) {
      // Advanced before running, so a crash mid-command never sends a message twice.
      updateSlackThread(ctx.db, t.inboxItemId, { lastSeenTs: m.ts }, now().toISOString());
      const appTs = getSlackThread(ctx.db, t.inboxItemId)?.appTs ?? t.appTs;
      if (appTs.includes(m.ts) || m.user !== myUserId || m.botId !== null || m.appId !== null) continue;
      await run(t, item, parseBridgeCommand(m.text));
    }
  }

  async function ensureThread(item: InboxItem, url: string): Promise<void> {
    if (!connected() || getSlackThread(ctx.db, item.id)) return;
    const cfg = ctx.config();
    const me = await d.slack.me();
    const pk = inboxSessionPk(item);
    const bridge = cfg.connectors.slack.dmBridge;
    const text = formatSlackItem(item, remoteUrl(url, cfg.remote.origin), bridge && isOwned(pk));
    const { ts } = await d.slack.post(me.dmChannelId, text);
    const at = now().toISOString();
    insertSlackThread(ctx.db, {
      inboxItemId: item.id,
      sessionPk: pk,
      channel: me.dmChannelId,
      rootTs: ts,
      lastSeenTs: ts,
      appTs: [ts],
      reactionsDone: [],
      state: bridge ? 'open' : 'resolved',
      createdAt: at,
      updatedAt: at,
    });
    if (cfg.connectors.slack.nudgeViaReminder) {
      try {
        await d.slack.nudge(`Orchestrator: ${KIND_TITLE[item.kind]} — ${item.reason}`);
      } catch (err) {
        ctx.log.warn({ err: String(err) }, 'slack reminder nudge failed');
      }
    }
  }

  async function onInboxUpserted(item: InboxItem): Promise<void> {
    if (item.state === 'done' || item.state === 'auto_resolved') await resolve(item.id, item.state);
  }

  async function poll(): Promise<void> {
    if (polling || !connected() || !ctx.config().connectors.slack.dmBridge) return;
    polling = true;
    try {
      const me = await d.slack.me();
      const items = new Map(
        need(ctx.inbox, 'inbox')
          .list({ state: ALL_STATES })
          .map((i) => [i.id, i]),
      );
      for (const t of listOpenSlackThreads(ctx.db)) {
        try {
          await pollThread(t, items.get(t.inboxItemId) ?? null, me.userId);
        } catch (err) {
          ctx.log.warn({ err: String(err), item: t.inboxItemId }, 'slack bridge poll failed');
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    ensureThread,
    onInboxUpserted,
    poll,
    start() {
      if (timer) return;
      unsubscribe = ctx.bus.on('inbox.upserted', (e) => {
        onInboxUpserted(e.item).catch((err: unknown) =>
          ctx.log.warn({ err: String(err) }, 'slack bridge resolve failed'),
        );
      });
      timer = setInterval(() => {
        poll().catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'slack bridge poll failed'));
      }, ctx.config().connectors.slack.bridgePollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
