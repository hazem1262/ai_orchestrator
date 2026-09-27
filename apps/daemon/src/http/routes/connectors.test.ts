import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import { P3_BASE, P3_TOKEN } from '../../../test/p3-harness.ts';
import { p6TestApp, send } from '../../../test/p6-app.ts';
import { fakeLinearApi, fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { p6Context } from '../../../test/p6-fakes.ts';
import { CENSUS, REGISTRAR_FILES } from '../../../test/route-census.ts';
import { createLinearConnector } from '../../connectors/linear/linear.ts';
import { createOAuthStateStore, type OAuthProvider } from '../../connectors/oauth.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import { getConnectorMeta } from '../../db/repos/connectors.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createApp } from '../app.ts';
import { matchAuditedRoute } from '../audit-middleware.ts';
import { PUBLIC_API_PATHS } from '../auth.ts';
import { registerConnectorRoutes } from './connectors.ts';

const SLACK_CALLBACK = 'http://127.0.0.1:4317/api/connectors/slack/callback';

describe('connector routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(o: { stateTtlMs?: number; now?: () => number } = {}) {
    const { ctx, audit } = p6Context();
    cleanups.push(() => ctx.dispose());
    const secrets = createMemorySecretStore();
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    const exchange = vi.fn<OAuthProvider['exchange']>(async () => ({
      accessToken: 'xoxp-oauth-token-123456',
      refreshToken: null,
      expiresInSec: null,
      accountId: 'U-ME',
      scopes: ['chat:write'],
    }));
    const provider: OAuthProvider = {
      id: 'slack',
      authorizeUrl: ({ clientId, redirectUri, state }) =>
        `https://slack.test/auth?c=${clientId}&r=${encodeURIComponent(redirectUri)}&state=${state}`,
      exchange,
    };
    const oauthState = createOAuthStateStore({
      ...(o.stateTtlMs !== undefined ? { ttlMs: o.stateTtlMs } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    const app = p6TestApp();
    registerConnectorRoutes(app, ctx, { secrets, linear, slack, providers: { slack: provider }, oauthState });
    return { ctx, audit, secrets, app, linearApi, slackApi, exchange, oauthState };
  }

  /** Saves the Slack OAuth app and returns a fresh state from the authorize route. */
  async function authorize(s: ReturnType<typeof setup>): Promise<string> {
    const saved = await send(s.app, 'POST', '/api/connectors/slack/app', {
      clientId: '123.456',
      clientSecret: 'shhh-secret-1',
    });
    expect(saved.status).toBe(200);
    const { url } = (await (await send(s.app, 'GET', '/api/connectors/slack/authorize')).json()) as {
      url: string;
    };
    return new URL(url).searchParams.get('state') ?? '';
  }

  it('connects Slack with a pasted token that never reaches SQLite', async () => {
    const s = setup();
    const token = 'xoxp-secret-token-987654321';
    const res = await send(s.app, 'POST', '/api/connectors/slack/token', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'slack',
      connected: true,
      status: 'ok',
      authKind: 'user_token',
      accountLabel: 'me @ Acme',
    });
    expect(await s.secrets.get('slack.token')).toBe(token);
    for (const f of [s.ctx.paths.dbFile, `${s.ctx.paths.dbFile}-wal`]) {
      if (existsSync(f)) expect(readFileSync(f).toString('latin1').includes(token)).toBe(false);
    }
    const entry = s.audit.list({ action: 'connector.connect' })[0];
    expect(entry).toMatchObject({ result: 'ok', target: 'slack' });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('rejects malformed and invalid tokens and restores the previous state', async () => {
    const s = setup();
    expect(
      (await send(s.app, 'POST', '/api/connectors/slack/token', { token: 'xoxb-bot-token-123' })).status,
    ).toBe(400);
    s.linearApi.control.failAuth = true;
    const res = await send(s.app, 'POST', '/api/connectors/linear/token', { token: 'lin_api_bad_token_1' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    expect(await s.secrets.get('linear.token')).toBeNull();
    expect(getConnectorMeta(s.ctx.db, 'linear')).toBeNull();
    expect(s.audit.list({ action: 'connector.connect' })[0]?.result).toBe('error');
  });

  it('refuses writes from remote devices', async () => {
    const s = setup();
    const res = await send(
      s.app,
      'POST',
      '/api/connectors/slack/token',
      { token: 'xoxp-1234567890-abc' },
      { 'x-test-remote': 'd1' },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('loopback_only');
  });

  it('runs the OAuth flow once per state', async () => {
    const s = setup();
    expect((await send(s.app, 'GET', '/api/connectors/slack/authorize')).status).toBe(409);
    expect(
      (
        await send(s.app, 'POST', '/api/connectors/slack/app', {
          clientId: '123.456',
          clientSecret: 'shhh-secret-1',
        })
      ).status,
    ).toBe(200);
    const { url } = (await (await send(s.app, 'GET', '/api/connectors/slack/authorize')).json()) as {
      url: string;
    };
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(url).toContain(encodeURIComponent(SLACK_CALLBACK));
    const ok = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Connected');
    expect(s.exchange).toHaveBeenCalledWith({
      clientId: '123.456',
      clientSecret: 'shhh-secret-1',
      code: 'abc',
      redirectUri: SLACK_CALLBACK,
    });
    expect(await s.secrets.get('slack.token')).toBe('xoxp-oauth-token-123456');
    expect(getConnectorMeta(s.ctx.db, 'slack')?.authKind).toBe('oauth');
    const replay = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);
    const denied = await send(s.app, 'GET', '/api/connectors/slack/callback?error=access_denied&state=x');
    expect(await denied.text()).toContain('access_denied');
  });

  it('escapes provider errors in the callback page', async () => {
    const s = setup();
    const res = await send(
      s.app,
      'GET',
      '/api/connectors/slack/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    );
    expect(await res.text()).not.toContain('<script>');
  });

  it('disconnects only with confirmation', async () => {
    const s = setup();
    await send(s.app, 'POST', '/api/connectors/linear/token', { token: 'lin_api_good_token_1' });
    const first = await send(s.app, 'DELETE', '/api/connectors/linear', {});
    expect(first.status).toBe(409);
    expect(
      ((await first.json()) as { error: { details: { summary: string } } }).error.details.summary,
    ).toContain('Disconnect linear');
    expect((await send(s.app, 'DELETE', '/api/connectors/linear', { confirm: true })).status).toBe(200);
    expect(await s.secrets.get('linear.token')).toBeNull();
    const list = (await (await send(s.app, 'GET', '/api/connectors')).json()) as Array<{
      id: string;
      connected: boolean;
    }>;
    expect(list).toEqual([
      expect.objectContaining({ id: 'linear', connected: false }),
      expect.objectContaining({ id: 'slack', connected: false }),
    ]);
    expect(s.audit.list({ action: 'connector.disconnect' })).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Added beyond the plan (security): the callback is public, so `state` is its only guard.
  // ---------------------------------------------------------------------------------------------
  describe('callback state checks', () => {
    async function expectRejected(s: ReturnType<typeof setup>, res: Response): Promise<void> {
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('Connected');
      expect(s.exchange).not.toHaveBeenCalled();
      expect(await s.secrets.get('slack.token')).toBeNull();
      expect(getConnectorMeta(s.ctx.db, 'slack')).toBeNull();
    }

    it('rejects a callback with no state', async () => {
      const s = setup();
      await authorize(s);
      await expectRejected(s, await send(s.app, 'GET', '/api/connectors/slack/callback?code=abc'));
    });

    it('rejects a callback with an empty state', async () => {
      const s = setup();
      await authorize(s);
      await expectRejected(s, await send(s.app, 'GET', '/api/connectors/slack/callback?code=abc&state='));
    });

    it('rejects a state the daemon never issued', async () => {
      const s = setup();
      await authorize(s);
      await expectRejected(
        s,
        await send(s.app, 'GET', '/api/connectors/slack/callback?code=abc&state=forged-state'),
      );
    });

    it('rejects a state issued for the other connector', async () => {
      const s = setup();
      await authorize(s);
      const linearState = s.oauthState.create('linear');
      await expectRejected(
        s,
        await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${linearState}`),
      );
    });

    it('rejects a Slack state presented on the Linear callback, and burns it', async () => {
      const s = setup();
      const state = await authorize(s);
      const res = await send(s.app, 'GET', `/api/connectors/linear/callback?code=abc&state=${state}`);
      expect(res.status).not.toBe(200);
      expect(await s.secrets.get('linear.token')).toBeNull();
      await expectRejected(
        s,
        await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`),
      );
    });

    it('rejects an expired state', async () => {
      let clock = 0;
      const s = setup({ stateTtlMs: 1000, now: () => clock });
      const state = await authorize(s);
      clock = 1001;
      await expectRejected(
        s,
        await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`),
      );
    });

    it('rejects a valid state with no code, without exchanging', async () => {
      const s = setup();
      const state = await authorize(s);
      await expectRejected(s, await send(s.app, 'GET', `/api/connectors/slack/callback?state=${state}`));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Added beyond the plan (security): no token or client secret in any response body.
  // ---------------------------------------------------------------------------------------------
  describe('token redaction in responses', () => {
    it('never echoes a pasted token, on success or in the status list', async () => {
      const s = setup();
      const token = 'xoxp-secret-token-987654321';
      const res = await send(s.app, 'POST', '/api/connectors/slack/token', { token });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(token);
      const list = await send(s.app, 'GET', '/api/connectors');
      expect(list.status).toBe(200);
      expect(await list.text()).not.toContain(token);
    });

    it('never echoes a rejected token in the error body', async () => {
      const s = setup();
      const malformed = 'xoxb-bot-token-abcdef123';
      const bad = await send(s.app, 'POST', '/api/connectors/slack/token', { token: malformed });
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain(malformed);

      s.linearApi.control.failAuth = true;
      const invalid = 'lin_api_badtokenabcdefghijklmnop';
      const res = await send(s.app, 'POST', '/api/connectors/linear/token', { token: invalid });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(invalid);
      expect(JSON.stringify(s.audit.list({ action: 'connector.connect' }))).not.toContain(invalid);
    });

    it('never echoes the OAuth client secret', async () => {
      const s = setup();
      const secret = 'shhh-client-secret-42';
      const saved = await send(s.app, 'POST', '/api/connectors/slack/app', {
        clientId: '123.456',
        clientSecret: secret,
      });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain(secret);
      const auth = await send(s.app, 'GET', '/api/connectors/slack/authorize');
      expect(auth.status).toBe(200);
      expect(await auth.text()).not.toContain(secret);
      expect(await (await send(s.app, 'GET', '/api/connectors')).text()).not.toContain(secret);
      expect(JSON.stringify(s.audit.list({}))).not.toContain(secret);
    });

    it('never puts the exchanged access token in the callback page', async () => {
      const s = setup();
      const state = await authorize(s);
      const ok = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain('xoxp-oauth-token-123456');
    });

    it('never puts a token or the client secret from a failed exchange in the callback page', async () => {
      const s = setup();
      s.exchange.mockRejectedValueOnce(
        new Error('upstream echoed xoxp-leaked-token-abcdef and client_secret=shhh-secret-1'),
      );
      const state = await authorize(s);
      const res = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).not.toContain('xoxp-leaked-token-abcdef');
      expect(html).not.toContain('shhh-secret-1');
      expect(await s.secrets.get('slack.token')).toBeNull();
    });

    it('never echoes the stored token when disconnecting', async () => {
      const s = setup();
      const token = 'lin_api_goodtokenabcdefghijklmnop';
      await send(s.app, 'POST', '/api/connectors/linear/token', { token });
      const first = await send(s.app, 'DELETE', '/api/connectors/linear', {});
      expect(first.status).toBe(409);
      expect(await first.text()).not.toContain(token);
      const done = await send(s.app, 'DELETE', '/api/connectors/linear', { confirm: true });
      expect(done.status).toBe(200);
      expect(await done.text()).not.toContain(token);
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Added beyond the plan (security + shipped conventions): the routes are mounted through the one
// registration path (`registerAllRoutes`, via `createApp`), and the OAuth callbacks are the ONLY
// newly public paths. Everything else still needs the loopback token.
// -----------------------------------------------------------------------------------------------
describe('connector routes on the real app', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function realApp() {
    const secrets = createMemorySecretStore();
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const ctx = createTestContext({
      secrets,
      linear: createLinearConnector({ secrets, api: () => linearApi }),
      slack: createSlackConnector({ secrets, api: () => slackApi }),
    });
    cleanups.push(() => ctx.dispose());
    const app = createApp({ ctx, token: P3_TOKEN, port: () => 4317, env: {} });
    const call = (
      method: string,
      path: string,
      o: { body?: unknown; token?: string | null; host?: string } = {},
    ): Promise<Response> => {
      const headers: Record<string, string> = { host: o.host ?? '127.0.0.1:4317' };
      if (o.token !== null) headers['x-orc-token'] = o.token ?? P3_TOKEN;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      return Promise.resolve(
        app.request(`${P3_BASE}${path}`, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        }),
      );
    };
    return { ctx, app, secrets, call };
  }

  it('makes exactly the two OAuth callbacks public', () => {
    expect([...PUBLIC_API_PATHS].sort()).toEqual([
      '/api/connectors/linear/callback',
      '/api/connectors/slack/callback',
    ]);
  });

  it('still answers 401 without the token on every other connector route', async () => {
    const t = realApp();
    const probes: Array<[string, string, unknown?]> = [
      ['GET', '/api/connectors'],
      ['POST', '/api/connectors/slack/token', { token: 'xoxp-1234567890-abc' }],
      ['POST', '/api/connectors/linear/token', { token: 'lin_api_good_token_1' }],
      ['POST', '/api/connectors/slack/app', { clientId: '123.456', clientSecret: 'shhh-secret-1' }],
      ['GET', '/api/connectors/slack/authorize'],
      ['GET', '/api/connectors/linear/authorize'],
      ['DELETE', '/api/connectors/slack', { confirm: true }],
      ['DELETE', '/api/connectors/linear', { confirm: true }],
      // Near-misses of the public paths must not inherit their exemption.
      ['GET', '/api/connectors/slack/callback/'],
      ['GET', '/api/connectors/Slack/callback'],
      ['GET', '/api/connectors/github/callback'],
      ['GET', '/api/connectors/slack/callback/extra'],
      ['POST', '/api/connectors/slack/callback'],
    ];
    for (const [method, path, body] of probes) {
      const res = await t.call(method, path, { token: null, body });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
    for (const [method, path, body] of probes.slice(0, 1)) {
      const res = await t.call(method, path, { token: 'wrong', body });
      expect(res.status).toBe(401);
    }
    expect(await t.secrets.get('slack.token')).toBeNull();
    expect(await t.secrets.get('linear.token')).toBeNull();
    expect(await t.secrets.get('slack.client_secret')).toBeNull();
  });

  it('answers 401 without the token on every registered /api route except the two callbacks', async () => {
    const t = realApp();
    const sample = (p: string) =>
      p.replace(/:([A-Za-z]+)(?:\{[^}]*\})?/g, (_m, name: string) => (name === 'source' ? 'claude' : 'x'));
    const routes = t.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL');
    expect(routes.map((r) => r.path)).toContain('/api/connectors');
    const open: string[] = [];
    for (const r of routes) {
      const path = sample(r.path);
      if (PUBLIC_API_PATHS.has(path)) continue;
      const res = await t.call(r.method, path, { token: null });
      if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('lets the browser reach the callback without the token, but still checks the host', async () => {
    const t = realApp();
    const res = await t.call('GET', '/api/connectors/slack/callback?code=abc&state=forged', { token: null });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await t.secrets.get('slack.token')).toBeNull();
    const badHost = await t.call('GET', '/api/connectors/slack/callback?code=abc&state=forged', {
      token: null,
      host: 'evil.example:4317',
    });
    expect(badHost.status).toBe(403);
  });

  it('audits a token paste once through the real middleware, with no token in the entry', async () => {
    const t = realApp();
    const token = 'xoxp-secret-token-987654321';
    const res = await t.call('POST', '/api/connectors/slack/token', { body: { token } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(token);
    const entries = t.ctx.audit?.list({ action: 'connector.connect' }) ?? [];
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('declares every connector route in the census and the audit lists', () => {
    for (const key of [
      'GET /api/connectors',
      'POST /api/connectors/:id/token',
      'POST /api/connectors/:id/app',
      'GET /api/connectors/:id/authorize',
      'GET /api/connectors/:id/callback',
      'DELETE /api/connectors/:id',
    ]) {
      expect(CENSUS[key], key).toBeDefined();
    }
    expect(REGISTRAR_FILES).toContain('apps/daemon/src/http/routes/connectors.ts');
    // Token paste, OAuth app save and disconnect are writes: each must be an audited route.
    expect(matchAuditedRoute('POST', '/api/connectors/slack/token')).not.toBeNull();
    expect(matchAuditedRoute('POST', '/api/connectors/linear/token')).not.toBeNull();
    expect(matchAuditedRoute('POST', '/api/connectors/slack/app')).not.toBeNull();
    expect(matchAuditedRoute('DELETE', '/api/connectors/slack')).not.toBeNull();
    expect(matchAuditedRoute('DELETE', '/api/connectors/linear')).not.toBeNull();
  });
});
