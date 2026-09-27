import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgncConnector } from '../../src/connectors/agnc/agnc.ts';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import {
  authGatedAgncFactory,
  FAKE_AGNC_AUTHORIZE_URL,
  fakeAgncFactory,
  makeFakeAgncAuth,
  makeFakeAgncState,
} from '../fakes/agnc-server.ts';
import { fakeAudit, fakeProjects, fakeSessions, testConfig } from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

const STATE = 'st-good-0123456789abcdef';
const CODE = 'code-secret-abcdef123456';
const GH_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function setup(o: { enabled?: boolean } = {}) {
  const cfg = testConfig({ agnc: { enabled: o.enabled ?? true } });
  const audit = fakeAudit();
  const state = makeFakeAgncState();
  const auth = makeFakeAgncAuth();
  const cleared: string[] = [];
  const agnc = createAgncConnector({
    clear: async () => {
      cleared.push('tokens');
    },
    factory: authGatedAgncFactory(state, auth),
    log: pino({ level: 'silent' }),
    state: () => STATE,
    pendingUrl: () => auth.pendingUrl,
  });
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    audit,
    sessions: fakeSessions(),
  });
  ctx.agnc = agnc;
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (
    path: string,
    o: { method?: string; token?: string | null; body?: unknown; host?: string } = {},
  ) =>
    app.request(`${o.host ? `http://${o.host}` : API_BASE}${path}`, {
      method: o.method ?? 'GET',
      headers: {
        ...(o.token === null ? {} : { 'x-orc-token': o.token ?? TEST_TOKEN }),
        ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  return { call, auth, audit, state, cleared };
}

describe('GET /oauth/agnc/callback', () => {
  it('finishes the flow with the right state, without the install token, and never shows the code', async () => {
    const t = setup();
    const begin = await t.call('/api/connectors/agnc/connect', { method: 'POST', body: {} });
    expect(await begin.json()).toEqual({ authorizationUrl: FAKE_AGNC_AUTHORIZE_URL });
    const res = await t.call(`/oauth/agnc/callback?code=${CODE}&state=${STATE}`, { token: null });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('AGNC connected');
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(STATE);
    expect(t.auth.finishedWith).toEqual([CODE]);
    expect(t.audit.entries.filter((e) => e.action === 'agnc.connect').map((e) => e.result)).toEqual([
      'ok',
      'ok',
    ]);
    expect(JSON.stringify(t.audit.entries)).not.toContain(CODE);
    expect(await (await t.call('/api/connectors/agnc/status')).json()).toMatchObject({ status: 'ok' });
    // The flow can be finished only once.
    const replay = await t.call(`/oauth/agnc/callback?code=${CODE}&state=${STATE}`, { token: null });
    expect(replay.status).toBe(400);
    expect(t.auth.finishedWith).toEqual([CODE]);
  });

  it('rejects a wrong or missing state before the code reaches AGNC', async () => {
    const t = setup();
    await t.call('/api/connectors/agnc/connect', { method: 'POST', body: {} });
    const forged = await t.call(`/oauth/agnc/callback?code=${CODE}&state=forged-state-1`, { token: null });
    expect(forged.status).toBe(400);
    const html = await forged.text();
    expect(html).toContain('expired or was already used');
    expect(html).not.toContain(CODE);
    expect(html).not.toContain('forged-state-1');
    const missing = await t.call(`/oauth/agnc/callback?code=${CODE}`, { token: null });
    expect(missing.status).toBe(400);
    const junk = await t.call(`/oauth/agnc/callback?code=${CODE}&state=%3Cscript%3E`, { token: null });
    expect(junk.status).toBe(400);
    expect(t.auth.finishedWith).toEqual([]);
    expect(t.auth.authorized).toBe(false);
  });

  it('shows the provider error redacted and escaped, and finishes nothing', async () => {
    const t = setup();
    const res = await t.call(
      `/oauth/agnc/callback?error=${encodeURIComponent(`<b>denied</b> ${GH_TOKEN}`)}&state=${STATE}&code=${CODE}`,
      { token: null },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('AGNC not connected');
    expect(html).not.toContain('<b>denied</b>');
    expect(html).toContain('&#60;b&#62;denied');
    expect(html).not.toContain(GH_TOKEN);
    expect(html).not.toContain(CODE);
    expect(t.auth.finishedWith).toEqual([]);
  });

  it('keeps the host check and the token check on every other /oauth path and method', async () => {
    const t = setup();
    const badHost = await t.call(`/oauth/agnc/callback?code=${CODE}&state=${STATE}`, {
      token: null,
      host: 'evil.example:4317',
    });
    expect(badHost.status).toBe(403);
    expect((await t.call('/oauth/agnc/callback/', { token: null })).status).toBe(401);
    expect((await t.call('/oauth/other', { token: null })).status).toBe(401);
    expect((await t.call('/oauth/agnc/callback', { method: 'POST', token: null, body: {} })).status).toBe(
      401,
    );
    expect(t.auth.finishedWith).toEqual([]);
  });

  it('scrubs the code and state from a failed exchange, on the page and in the audit log', async () => {
    const t = setup();
    const agnc = ctx?.agnc;
    if (!agnc) throw new Error('no connector');
    agnc.finishAuth = async (code, state) => {
      throw new Error(`token exchange failed for ${code} / ${state} with ${GH_TOKEN}`);
    };
    const res = await t.call(`/oauth/agnc/callback?code=${CODE}&state=${STATE}`, { token: null });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('token exchange failed');
    for (const secret of [CODE, STATE, GH_TOKEN]) {
      expect(html).not.toContain(secret);
      expect(JSON.stringify(t.audit.entries)).not.toContain(secret);
    }
    expect(t.audit.entries.find((e) => e.action === 'agnc.connect')).toMatchObject({ result: 'error' });
  });

  it('answers 409 while AGNC is off', async () => {
    const t = setup({ enabled: false });
    const res = await t.call(`/oauth/agnc/callback?code=${CODE}&state=${STATE}`, { token: null });
    expect(res.status).toBe(409);
    expect(t.auth.finishedWith).toEqual([]);
  });
});

describe('AGNC routes, beyond the plan test', () => {
  it('answers 409 not_enabled while agnc.enabled is off, even with the connector wired', async () => {
    const t = setup({ enabled: false });
    expect(await (await t.call('/api/connectors/agnc/status')).json()).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    for (const [method, path, body] of [
      ['GET', '/api/agnc/sessions/ag-1/messages'],
      ['GET', '/api/agnc/sessions/ag-1/events'],
      ['POST', '/api/agnc/sessions/ag-1/prompt', { prompt: 'x', confirm: true }],
      ['POST', '/api/agnc/handoff', { source: 'claude', id: 's1', confirm: true }],
      ['POST', '/api/connectors/agnc/connect', {}],
      ['POST', '/api/connectors/agnc/disconnect', { confirm: true }],
    ] as const) {
      const res = await t.call(path, { method, body });
      expect({ path, status: res.status }).toEqual({ path, status: 409 });
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_enabled');
    }
  });

  it('redacts the prompt before it leaves, and keeps the text out of the audit log', async () => {
    const cfg = testConfig({ agnc: { enabled: true } });
    const audit = fakeAudit();
    const state = makeFakeAgncState();
    ctx = createTestContext({
      config: () => cfg,
      projects: fakeProjects(cfg),
      audit,
      sessions: fakeSessions(),
    });
    ctx.agnc = createAgncConnector({ factory: fakeAgncFactory(state), log: pino({ level: 'silent' }) });
    const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
    const post = (body: unknown) =>
      app.request(`${API_BASE}/api/agnc/sessions/ag-1/prompt`, {
        method: 'POST',
        headers: { 'x-orc-token': TEST_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const unconfirmed = await post({ prompt: `use ${GH_TOKEN}` });
    expect(unconfirmed.status).toBe(409);
    expect(JSON.stringify(await unconfirmed.json())).not.toContain(GH_TOKEN);
    expect(state.prompts).toEqual([]);
    expect((await post({ prompt: `use ${GH_TOKEN}`, confirm: true })).status).toBe(200);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]?.prompt).not.toContain(GH_TOKEN);
    expect(state.prompts[0]?.prompt).toContain('«redacted:github»');
    expect(JSON.stringify(audit.entries)).not.toContain('redacted:github');
  });

  it('disconnects only after confirmation and forgets the stored tokens', async () => {
    const t = setup();
    expect((await t.call('/api/connectors/agnc/disconnect', { method: 'POST', body: {} })).status).toBe(409);
    expect(t.audit.entries.find((e) => e.action === 'agnc.disconnect')).toBeUndefined();
    expect(t.cleared).toEqual([]);
    const ok = await t.call('/api/connectors/agnc/disconnect', { method: 'POST', body: { confirm: true } });
    expect(ok.status).toBe(200);
    expect(t.audit.entries.find((e) => e.action === 'agnc.disconnect')).toMatchObject({ result: 'ok' });
    expect(t.cleared).toEqual(['tokens']);
  });
});
