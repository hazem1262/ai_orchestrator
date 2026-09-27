import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.ts';
import { createPhase6 } from '../src/phase6.ts';
import { createMemorySecretStore } from '../src/services/secrets/secret-store.ts';
import { useTempHomes } from './helpers.ts';
import { fakeLinearApi, fakeSlackApi } from './p6-connector-fakes.ts';
import { p6Context } from './p6-fakes.ts';

const TOKEN = 'a'.repeat(64);
type Err = { error: { code: string } };

describe('phase 6 wiring', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function boot() {
    const { ctx, notifier } = p6Context();
    cleanups.push(() => ctx.dispose());
    const secrets = createMemorySecretStore();
    const p6 = createPhase6(ctx, {
      secrets,
      linearApi: () => fakeLinearApi(),
      slackApi: () => fakeSlackApi(),
      pushSender: async () => ({ statusCode: 201 }),
      idle: async () => 0,
      run: async () => '{}',
    });
    cleanups.push(() => p6.stop());
    const app = createApp({ ctx, token: TOKEN, port: () => 4317, remote: p6.guardDeps, phase6: p6 });
    const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      app.request(
        `http://127.0.0.1:4317${path}`,
        {
          method,
          headers: { host: '127.0.0.1:4317', 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      );
    return { ctx, notifier, p6, req };
  }

  it('exposes the phase 6 routes through createApp and fills the context', async () => {
    const b = boot();
    expect(b.ctx.secrets).toBeDefined();
    expect(b.ctx.linear).toBeDefined();
    expect(b.ctx.slack).toBeDefined();
    expect(b.ctx.share).toBeDefined();
    expect(b.ctx.sessionActions).toBeDefined();
    expect(b.ctx.away).toBeDefined();
    expect(b.notifier.channels.map((c) => c.id).sort()).toEqual(['slack_dm', 'webpush']);

    const list = await b.req('GET', '/api/connectors', { 'x-orc-token': TOKEN });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: 'linear', connected: false }),
      expect.objectContaining({ id: 'slack', connected: false }),
    ]);
    expect((await b.req('GET', '/api/remote/away', { 'x-orc-token': TOKEN })).status).toBe(200);
    expect((await b.req('GET', '/api/push/vapid-public-key', { 'x-orc-token': TOKEN })).status).toBe(200);
    expect((await b.req('GET', '/api/connectors', {})).status).toBe(401);
  });

  it('lets the OAuth callback through without a token but blocks remote requests while remote is off', async () => {
    const b = boot();
    const callback = await b.req('GET', '/api/connectors/slack/callback?error=access_denied');
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain('access_denied');
    const remote = await b.req('GET', '/api/live', {
      'x-forwarded-host': 'mac.tail1234.ts.net',
      'tailscale-user-login': 'me@example.com',
    });
    expect(remote.status).toBe(403);
    expect(((await remote.json()) as Err).error.code).toBe('remote_disabled');
  });

  it('starts and stops every background job without keeping the process alive', () => {
    const b = boot();
    b.p6.start();
    b.p6.stop();
    b.p6.stop();
  });
});
