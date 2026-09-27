import { describe, expect, it, vi } from 'vitest';
import type { Caller } from './client-p2.ts';
import { isApiErrorWithCode, p6Methods } from './client-p6.ts';
import { OrcConfig } from './config.ts';
import {
  LinearCommentBody,
  LinearFollowUpBody,
  ShareSource,
  SlackPostBody,
  TokenBody,
} from './routes/connectors.ts';
import { AwayBody, PairBody, PushSubscriptionBody, RemoteConfigBody } from './routes/remote.ts';

describe('phase 6 config', () => {
  it('fills remote, away and connector defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.remote).toEqual({
      enabled: false,
      origin: null,
      allowedLogin: null,
      stepUpTtlSec: 300,
      pairingTtlSec: 300,
    });
    expect(c.away).toEqual({ auto: true, idleMinutes: 10, channels: ['webpush', 'slack_dm'] });
    expect(c.connectors.slack).toMatchObject({
      enabled: true,
      redirectUri: 'http://127.0.0.1:4317/api/connectors/slack/callback',
      dmBridge: true,
      bridgePollSeconds: 15,
      nudgeViaReminder: false,
      dailyChannel: null,
    });
    expect(c.connectors.linear).toMatchObject({ enabled: true, pollSeconds: 120, defaultTeamKey: null });
  });

  it('keeps partial connector config and fills the rest', () => {
    const c = OrcConfig.parse({ connectors: { slack: { dailyChannel: 'C0123456' } } });
    expect(c.connectors.slack.dailyChannel).toBe('C0123456');
    expect(c.connectors.slack.pollSeconds).toBe(60);
    expect(c.connectors.linear.pollSeconds).toBe(120);
  });
});

describe('phase 6 schemas', () => {
  it('validates share sources', () => {
    expect(ShareSource.parse({ kind: 'recap', sessionPk: 'claude:s1' })).toEqual({
      kind: 'recap',
      sessionPk: 'claude:s1',
    });
    expect(ShareSource.safeParse({ kind: 'daily', projectId: 'wakecap', date: '17-09-2026' }).success).toBe(
      false,
    );
    expect(ShareSource.safeParse({ kind: 'text', text: '' }).success).toBe(false);
    expect(LinearCommentBody.parse({ source: { kind: 'text', text: 'hi' } }).confirm).toBeUndefined();
  });

  it('validates follow-up and slack bodies', () => {
    const f = LinearFollowUpBody.parse({ sessionPk: 'claude:s1', title: 'Fix flaky test' });
    expect(f).toMatchObject({ description: '', includeRecap: true });
    expect(LinearFollowUpBody.safeParse({ sessionPk: 'claude:s1', title: 'x', teamKey: 'saf' }).success).toBe(
      false,
    );
    expect(
      SlackPostBody.safeParse({ channel: '#general', source: { kind: 'text', text: 'x' } }).success,
    ).toBe(false);
    expect(SlackPostBody.parse({ channel: 'C0123ABCD', source: { kind: 'text', text: 'x' } }).channel).toBe(
      'C0123ABCD',
    );
  });

  it('validates remote bodies', () => {
    expect(PairBody.safeParse({ code: 'ABCD2345', name: 'Phone' }).success).toBe(true);
    expect(PairBody.safeParse({ code: 'abcd0000', name: 'Phone' }).success).toBe(false);
    expect(TokenBody.safeParse({ token: 'short' }).success).toBe(false);
    expect(AwayBody.parse({ mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(
      RemoteConfigBody.safeParse({
        enabled: true,
        origin: 'http://mac.ts.net',
        allowedLogin: 'me@example.com',
      }).success,
    ).toBe(false);
    expect(
      RemoteConfigBody.parse({
        enabled: true,
        origin: 'https://mac.tail1234.ts.net',
        allowedLogin: 'me@example.com',
      }).origin,
    ).toBe('https://mac.tail1234.ts.net');
    expect(
      PushSubscriptionBody.safeParse({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'BExampleKey123', auth: 'authsecret1' },
      }).success,
    ).toBe(true);
  });
});

describe('p6Methods', () => {
  it('maps methods to routes', async () => {
    const call = vi.fn(async () => ({ ok: true })) as unknown as Caller & ReturnType<typeof vi.fn>;
    const api = p6Methods(call);
    await api.connectorsSetToken('slack', 'xoxp-1234567890');
    await api.sessionsReply('claude', 's/1', 'yes');
    await api.inboxApprove('i1');
    await api.pushUnsubscribe('https://push.example/1');
    await api.remoteRevokeDevice('d1');
    expect(call.mock.calls).toEqual([
      ['POST', '/api/connectors/slack/token', { token: 'xoxp-1234567890' }],
      ['POST', '/api/sessions/claude/s%2F1/reply', { text: 'yes' }],
      ['POST', '/api/inbox/i1/approve', { confirm: true }],
      ['DELETE', '/api/push/subscriptions', { endpoint: 'https://push.example/1' }],
      ['DELETE', '/api/remote/devices/d1', { confirm: true }],
    ]);
  });

  it('recognises API error codes', () => {
    expect(
      isApiErrorWithCode({ status: 401, code: 'step_up_required', message: 'x' }, 'step_up_required'),
    ).toBe(true);
    expect(isApiErrorWithCode(new Error('x'), 'step_up_required')).toBe(false);
  });
});
