import { describe, expect, it } from 'vitest';
import { fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createSlackConnector, toSlackError } from './slack.ts';
import { compareSlackTs, decodeSlackText, slackTsFromDate } from './text.ts';

function setup(token: string | null = 'xoxp-test-123456') {
  const api = fakeSlackApi();
  const slack = createSlackConnector({
    secrets: createMemorySecretStore(token ? { 'slack.token': token } : {}),
    api: () => api,
    now: () => Date.parse('2026-09-17T10:00:00.000Z'),
  });
  return { api, slack };
}

describe('slack text helpers', () => {
  it('compares timestamps numerically', () => {
    expect(compareSlackTs('1758100000.000100', '1758100000.000099')).toBe(1);
    expect(compareSlackTs('1758099999.999999', '1758100000.000000')).toBe(-1);
    expect(compareSlackTs('10.5', '10.500000')).toBe(0);
    expect(slackTsFromDate(new Date(1758100000123))).toBe('1758100000.123000');
    expect(decodeSlackText('a &lt;b&gt; &amp; c')).toBe('a <b> & c');
  });
});

describe('SlackConnector', () => {
  it('reports status and identity', async () => {
    expect(await setup(null).slack.status()).toBe('unauthenticated');
    const s = setup();
    expect(await s.slack.me()).toEqual({ userId: 'U-ME', dmChannelId: 'D-ME', label: 'me @ Acme' });
    expect(await s.slack.status()).toBe('ok');
    s.api.control.failAuth = true;
    s.slack.invalidate();
    expect(await s.slack.status()).toBe('unauthenticated');
  });

  it('redacts posts and returns only newer thread replies', async () => {
    const s = setup();
    const root = await s.slack.post('D-ME', 'key xoxb-123456-abcdef leaked');
    expect(s.api.posts[0]?.text).toBe('key «redacted:slack» leaked');
    const first = s.api.userReply(root.ts, 'yes');
    const second = s.api.userReply(root.ts, 'and run tests');
    expect((await s.slack.replies('D-ME', root.ts)).map((r) => r.text)).toEqual(['yes', 'and run tests']);
    const after = await s.slack.replies('D-ME', root.ts, first);
    expect(after).toEqual([{ ts: second, user: 'U-ME', text: 'and run tests', botId: null, appId: null }]);
  });

  it('returns my reactions on a message', async () => {
    const s = setup();
    const root = await s.slack.post('D-ME', 'item');
    s.api.react(root.ts, 'white_check_mark');
    s.api.react(root.ts, 'eyes', 'U-OTHER');
    expect(await s.slack.reactions('D-ME', root.ts)).toEqual(['white_check_mark']);
  });

  it('finds mentions after a timestamp, excluding my DM', async () => {
    const s = setup();
    s.api.search.push(
      { channel: 'C1', ts: '1758100001.000000', text: 'hey <@U-ME> review?' },
      { channel: 'C1', ts: '1758099000.000000', text: 'old' },
      { channel: 'D-ME', ts: '1758100002.000000', text: 'self' },
    );
    expect(await s.slack.mentions('1758100000.000000')).toEqual([
      { channel: 'C1', ts: '1758100001.000000', text: 'hey <@U-ME> review?' },
    ]);
  });

  it('nudges with a redacted reminder', async () => {
    const s = setup();
    await s.slack.nudge('Waiting: token=abc');
    expect(s.api.reminders).toEqual(['Waiting: token=«redacted:secret»']);
  });

  it('maps Slack platform errors', () => {
    const e = (error: string) => Object.assign(new Error(error), { data: { error } });
    expect(toSlackError(e('token_revoked')).code).toBe('unauthenticated');
    expect(toSlackError(e('channel_not_found')).code).toBe('not_found');
    expect(toSlackError(e('missing_scope')).code).toBe('bad_request');
    expect(toSlackError(new Error('ETIMEDOUT')).code).toBe('upstream_error');
  });
});
