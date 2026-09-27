import { describe, expect, it } from 'vitest';
import { fakeSlackApi } from '../../test/p6-connector-fakes.ts';
import { createOAuthStateStore, SLACK_USER_SCOPES, slackOAuthProvider } from './oauth.ts';

describe('OAuth helpers', () => {
  it('builds the Slack user-scope authorize URL', () => {
    const url = new URL(
      slackOAuthProvider(() => fakeSlackApi()).authorizeUrl({
        clientId: '123.456',
        redirectUri: 'http://127.0.0.1:4317/api/connectors/slack/callback',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(SLACK_USER_SCOPES.join(','));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('exchanges a code for the authed_user token', async () => {
    const tokens = await slackOAuthProvider(() => fakeSlackApi()).exchange({
      clientId: 'c',
      clientSecret: 's',
      code: 'k',
      redirectUri: 'r',
    });
    expect(tokens).toEqual({
      accessToken: 'xoxp-from-oauth-123456',
      refreshToken: null,
      expiresInSec: null,
      accountId: 'U-ME',
      scopes: ['chat:write', 'im:history'],
    });
  });

  it('accepts a state once, for the right connector, before it expires', () => {
    let now = 0;
    const store = createOAuthStateStore({ ttlMs: 1000, now: () => now });
    const a = store.create('slack');
    expect(store.consume(a, 'linear')).toBe(false);
    const b = store.create('slack');
    expect(store.consume(b, 'slack')).toBe(true);
    expect(store.consume(b, 'slack')).toBe(false);
    const c = store.create('slack');
    now = 1001;
    expect(store.consume(c, 'slack')).toBe(false);
  });

  // Added (security): the state is the only thing guarding the public callback.
  it('rejects a state it never issued, and an empty one', () => {
    const store = createOAuthStateStore();
    store.create('slack');
    expect(store.consume('not-a-real-state', 'slack')).toBe(false);
    expect(store.consume('', 'slack')).toBe(false);
  });

  it('issues unguessable, distinct states', () => {
    const store = createOAuthStateStore();
    const states = new Set(Array.from({ length: 50 }, () => store.create('slack')));
    expect(states.size).toBe(50);
    for (const s of states) expect(s.length).toBeGreaterThanOrEqual(22);
  });

  it('burns a state that was presented for the wrong connector', () => {
    const store = createOAuthStateStore();
    const s = store.create('slack');
    expect(store.consume(s, 'linear')).toBe(false);
    expect(store.consume(s, 'slack')).toBe(false);
  });
});
