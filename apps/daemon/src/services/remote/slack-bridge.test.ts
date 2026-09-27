import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../../test/helpers.ts';
import { fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { makeInboxItem, makeP6Session, ownedLive, p6Context } from '../../../test/p6-fakes.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import { upsertConnectorMeta } from '../../db/repos/connectors.ts';
import { getSlackThread } from '../../db/repos/slack-threads.ts';
import { inboxDedupeKey } from '../../inbox/engine.ts';
import { createSlackDmChannel } from '../../notify/slack-dm.ts';
import { createMemorySecretStore } from '../secrets/secret-store.ts';
import { createSessionActions } from './session-actions.ts';
import { createSlackBridge, formatSlackItem, parseBridgeCommand } from './slack-bridge.ts';

const T = '2026-09-17T10:00:00.000Z';
const URL_LOCAL = 'http://127.0.0.1:4317/sessions/claude/s1';
const WAITING_KEY = { kind: 'waiting', scope: { session: 'claude:s1' } } as const;

describe('slack bridge helpers', () => {
  it('parses commands', () => {
    expect(parseBridgeCommand('!done')).toEqual({ kind: 'done' });
    expect(parseBridgeCommand(' !APPROVE ')).toEqual({ kind: 'approve' });
    expect(parseBridgeCommand('!snooze')).toEqual({ kind: 'snooze', minutes: 60 });
    expect(parseBridgeCommand('!snooze 5000')).toEqual({ kind: 'snooze', minutes: 1440 });
    expect(parseBridgeCommand('use &lt;T&gt; &amp; go')).toEqual({ kind: 'reply', text: 'use <T> & go' });
  });

  it('formats items without Slack markup injection', () => {
    const text = formatSlackItem(
      makeInboxItem({ id: 'i', reason: 'Pick <!channel> or <https://x|y>?' }),
      'https://mac.ts.net/x',
      true,
    );
    expect(text).toContain('*Waiting for you* · wakecap · SAF-1787');
    expect(text).toContain('Pick &lt;!channel&gt; or &lt;https://x|y&gt;?');
    expect(text).toContain('<https://mac.ts.net/x|Open in Orchestrator>');
    expect(text).toContain('Reply in this thread');
    expect(formatSlackItem(makeInboxItem({ id: 'i' }), 'u', false)).toContain('replies are off');
  });
});

describe('slack bridge', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { owned?: boolean; connected?: boolean; config?: Record<string, unknown> } = {}) {
    const session = makeP6Session({
      id: 's1',
      live: o.owned === false ? { ...ownedLive(), ownership: 'observed', ptyId: null } : ownedLive('pty-1'),
    });
    const items = [
      makeInboxItem({
        id: 'w1',
        reason: 'Waiting: run migrations? password=hunter2',
        dedupeKey: inboxDedupeKey(WAITING_KEY),
      }),
      makeInboxItem({
        id: 'p1',
        kind: 'plan_approval',
        dedupeKey: 'plan:claude:s1',
        payload: { source: 'claude', id: 's1', approveText: 'approved' },
      }),
    ];
    const env = p6Context({
      sessions: [session],
      inbox: items,
      config: o.config ?? {
        remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' },
      },
    });
    cleanups.push(() => env.ctx.dispose());
    if (o.connected !== false) {
      upsertConnectorMeta(env.ctx.db, {
        connector: 'slack',
        authKind: 'user_token',
        accountId: 'U-ME',
        accountLabel: 'me',
        scopes: [],
        connectedAt: T,
      });
    }
    const api = fakeSlackApi();
    const slack = createSlackConnector({
      secrets: createMemorySecretStore({ 'slack.token': 'xoxp-test-123456' }),
      api: () => api,
    });
    const bridge = createSlackBridge({
      ctx: env.ctx,
      slack,
      actions: createSessionActions(env.ctx),
      now: () => new Date(T),
    });
    bridge.start();
    cleanups.push(() => bridge.stop());
    const channel = createSlackDmChannel(bridge);
    const item = (id: string) => {
      const found = env.inbox.items.find((i) => i.id === id);
      if (!found) throw new Error(id);
      return found;
    };
    return { ...env, api, bridge, channel, item };
  }

  it('posts one redacted DM thread per item with a tailnet link', async () => {
    const b = build();
    await b.channel.send(b.item('w1'), URL_LOCAL);
    await b.channel.send(b.item('w1'), URL_LOCAL);
    expect(b.api.posts).toHaveLength(1);
    expect(b.api.posts[0]?.channel).toBe('D-ME');
    expect(b.api.posts[0]?.text).toContain('password=«redacted:secret»');
    expect(b.api.posts[0]?.text).toContain(
      '<https://mac.tail1234.ts.net/sessions/claude/s1|Open in Orchestrator>',
    );
    expect(getSlackThread(b.ctx.db, 'w1')).toMatchObject({
      sessionPk: 'claude:s1',
      state: 'open',
      channel: 'D-ME',
    });
  });

  it('sends my thread replies to the owned session exactly once', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'yes, run them');
    b.api.userReply(root, 'ignore me', 'U-OTHER');
    await b.bridge.poll();
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, run them' }]);
    expect(b.api.posts.at(-1)).toMatchObject({ threadTs: root, text: ':arrow_right: Sent to the session.' });
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({
      actor: 'remote',
      actorDetail: 'slack_dm',
    });
  });

  it('reports refusals in the thread', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'terraform apply now');
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([]);
    expect(b.api.posts.at(-1)?.text).toMatch(/^:x: Not done \(denied\)/);
  });

  it('refuses replies for sessions the app does not own', async () => {
    const b = build({ owned: false });
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    expect(b.api.posts[0]?.text).toContain('replies are off');
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'continue');
    await b.bridge.poll();
    expect(b.api.posts.at(-1)?.text).toMatch(/^:x: Not done \(not_owned\)/);
  });

  it('approves on ✅ once and resolves the thread', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('p1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'p1')?.rootTs ?? '';
    b.api.react(root, 'white_check_mark');
    await b.bridge.poll();
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'p1')?.state).toBe('resolved'));
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'approved' }]);
    expect(b.item('p1').state).toBe('done');
    await vi.waitFor(() =>
      expect(b.api.posts.some((p) => p.text.startsWith(':heavy_check_mark: Resolved'))).toBe(true),
    );
  });

  it('snoozes on 💤 and on !snooze, and marks done on !done', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.react(root, 'zzz');
    await b.bridge.poll();
    expect(b.item('w1')).toMatchObject({ state: 'snoozed', snoozeUntil: '2026-09-17T11:00:00.000Z' });
    b.api.userReply(root, '!snooze 30');
    await b.bridge.poll();
    expect(b.item('w1').snoozeUntil).toBe('2026-09-17T10:30:00.000Z');
    b.api.userReply(root, '!done');
    await b.bridge.poll();
    expect(b.item('w1').state).toBe('done');
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'w1')?.state).toBe('resolved'));
  });

  it('resolves when the inbox item clears on its own', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    b.inbox.resolve(WAITING_KEY);
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'w1')?.state).toBe('resolved'));
    await vi.waitFor(() =>
      expect(b.api.posts.at(-1)?.text).toBe(':heavy_check_mark: Resolved (condition cleared).'),
    );
  });

  it('does nothing when Slack is not connected, and does not poll when the bridge is off', async () => {
    const off = build({ connected: false });
    await off.bridge.ensureThread(off.item('w1'), URL_LOCAL);
    expect(off.api.posts).toEqual([]);
    const noBridge = build({ config: { connectors: { slack: { dmBridge: false } } } });
    await noBridge.bridge.ensureThread(noBridge.item('w1'), URL_LOCAL);
    expect(noBridge.api.posts).toHaveLength(1);
    expect(getSlackThread(noBridge.ctx.db, 'w1')?.state).toBe('resolved');
  });

  it('nudges through a Slackbot reminder when configured', async () => {
    const b = build({ config: { connectors: { slack: { nudgeViaReminder: true } } } });
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    expect(b.api.reminders).toEqual([
      'Orchestrator: Waiting for you — Waiting: run migrations? password=«redacted:secret»',
    ]);
  });
});
