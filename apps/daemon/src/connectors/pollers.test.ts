import { afterEach, describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { fakeLinearApi, fakeSlackApi, linearIssue } from '../../test/p6-connector-fakes.ts';
import { p6Context } from '../../test/p6-fakes.ts';
import { getConnectorMeta, setConnectorCursor, upsertConnectorMeta } from '../db/repos/connectors.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { createMemorySecretStore } from '../services/secrets/secret-store.ts';
import { createLinearAssignedPoller } from './linear/assigned-poller.ts';
import { createLinearConnector } from './linear/linear.ts';
import { createSlackMentionPoller } from './slack/mention-poller.ts';
import { createSlackConnector } from './slack/slack.ts';
import { createStreamEnricher, type StreamTitleStore } from './stream-enricher.ts';

const T = '2026-09-17T10:00:00.000Z';

describe('connector pollers', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup() {
    const { ctx } = p6Context();
    cleanups.push(() => ctx.dispose());
    const events: BusEvent[] = [];
    ctx.bus.on('linear.issueChanged', (e) => events.push(e));
    ctx.bus.on('slack.mention', (e) => events.push(e));
    const secrets = createMemorySecretStore({
      'linear.token': 'lin_api_test_123',
      'slack.token': 'xoxp-test-123456',
    });
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi, cacheTtlMs: 0 });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    return { ctx, events, linearApi, slackApi, linear, slack };
  }

  it('does nothing until Linear is connected', async () => {
    const s = setup();
    s.linearApi.assigned.push(linearIssue('SAF-1'));
    await createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear }).tick();
    expect(s.events).toEqual([]);
  });

  it('seeds silently, then emits new and changed assigned issues, keeping other cursor keys', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, {
      connector: 'linear',
      authKind: 'api_key',
      accountId: 'user-1',
      accountLabel: 'me',
      scopes: [],
      connectedAt: T,
    });
    setConnectorCursor(s.ctx.db, 'linear', { tokenExpiresAt: '2026-09-18T00:00:00.000Z' });
    const poller = createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear });
    s.linearApi.assigned.push(linearIssue('SAF-1'));
    await poller.tick();
    expect(s.events).toEqual([]);

    s.linearApi.assigned.push(linearIssue('SAF-2'));
    s.linearApi.assigned[0] = linearIssue('SAF-1', { state: 'In Review' });
    await poller.tick();
    expect(s.events).toEqual([
      {
        type: 'linear.issueChanged',
        before: expect.objectContaining({ identifier: 'SAF-1', state: 'In Progress' }),
        after: expect.objectContaining({ state: 'In Review' }),
      },
      { type: 'linear.issueChanged', before: null, after: expect.objectContaining({ identifier: 'SAF-2' }) },
    ]);
    await poller.tick();
    expect(s.events).toHaveLength(2);
    expect(getConnectorMeta(s.ctx.db, 'linear')?.cursor.tokenExpiresAt).toBe('2026-09-18T00:00:00.000Z');
  });

  it('records auth failures without moving the cursor', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, {
      connector: 'linear',
      authKind: 'api_key',
      accountId: 'user-1',
      accountLabel: 'me',
      scopes: [],
      connectedAt: T,
    });
    s.linearApi.control.failAuth = true;
    s.linearApi.assignedIssues = async () => {
      throw Object.assign(new Error('auth'), { type: 'AuthenticationError' });
    };
    await createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear }).tick();
    expect(getConnectorMeta(s.ctx.db, 'linear')).toMatchObject({ lastStatus: 'unauthenticated', cursor: {} });
  });

  it('seeds the Slack mention cursor, then emits redacted mentions in order', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, {
      connector: 'slack',
      authKind: 'user_token',
      accountId: 'U-ME',
      accountLabel: 'me',
      scopes: [],
      connectedAt: T,
    });
    const poller = createSlackMentionPoller({
      ctx: s.ctx,
      slack: s.slack,
      now: () => new Date(1758100000000),
    });
    await poller.tick();
    expect(getConnectorMeta(s.ctx.db, 'slack')?.cursor.mentionsSinceTs).toBe('1758100000.000000');
    s.slackApi.search.push(
      { channel: 'C1', ts: '1758100005.000000', text: '<@U-ME> second password=abc' },
      { channel: 'C1', ts: '1758100001.000000', text: '<@U-ME> first' },
    );
    await poller.tick();
    expect(s.events).toEqual([
      { type: 'slack.mention', channel: 'C1', ts: '1758100001.000000', text: '<@U-ME> first' },
      {
        type: 'slack.mention',
        channel: 'C1',
        ts: '1758100005.000000',
        text: '<@U-ME> second password=«redacted:secret»',
      },
    ]);
    await poller.tick();
    expect(s.events).toHaveLength(2);
    expect(getConnectorMeta(s.ctx.db, 'slack')?.cursor.mentionsSinceTs).toBe('1758100005.000000');
  });

  it('fills missing stream titles from Linear', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, {
      connector: 'linear',
      authKind: 'api_key',
      accountId: 'user-1',
      accountLabel: 'me',
      scopes: [],
      connectedAt: T,
    });
    const rows = [
      { ticket: 'SAF-1787', title: null as string | null },
      { ticket: 'SAF-404', title: null as string | null },
      { ticket: 'SAF-1', title: 'Already set' as string | null },
    ];
    const store: StreamTitleStore = {
      list: () => rows,
      setTitle: (ticket, title) => {
        const r = rows.find((x) => x.ticket === ticket);
        if (r) r.title = title;
      },
    };
    await createStreamEnricher({ ctx: s.ctx, linear: s.linear, store }).tick();
    expect(rows).toEqual([
      { ticket: 'SAF-1787', title: 'Title of SAF-1787' },
      { ticket: 'SAF-404', title: null },
      { ticket: 'SAF-1', title: 'Already set' },
    ]);
  });
});
