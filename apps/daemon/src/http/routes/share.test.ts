import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Handoff } from '@orc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import { P3_BASE, P3_TOKEN } from '../../../test/p3-harness.ts';
import { p6TestApp, send } from '../../../test/p6-app.ts';
import { fakeLinearApi, fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { makeP6Session, p6Context } from '../../../test/p6-fakes.ts';
import { CENSUS, REGISTRAR_FILES } from '../../../test/route-census.ts';
import { createLinearConnector } from '../../connectors/linear/linear.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import type { HandoffService } from '../../services/handoff/handoff.ts';
import type { RecapService } from '../../services/recap/recap.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createShareService } from '../../services/share/share.ts';
import { createApp } from '../app.ts';
import { matchAuditedRoute } from '../audit-middleware.ts';
import { registerShareRoutes } from './share.ts';

type ErrBody = { error: { code: string; details?: { summary: string; preview: string } } };

describe('share routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(o: { config?: Record<string, unknown>; linearToken?: boolean } = {}) {
    const session = makeP6Session({ id: 's1', name: 'SAF-1787 SLA weekends', tickets: ['SAF-1787'] });
    const { ctx, audit } = p6Context({ sessions: [session], config: o.config });
    cleanups.push(() => ctx.dispose());
    const handoff: Handoff = {
      id: 'h1',
      sessionId: 'claude:s1',
      status: 'in_review',
      summary: 'Weekends excluded',
      evidence: [],
      files: [],
      nextSteps: ['merge'],
      blockers: [],
      links: [],
      createdAt: '2026-09-17T09:00:00.000Z',
    };
    const recaps = {
      recap: vi.fn(async () => ({
        text: 'Ran tests with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        costUsd: 0.01,
        model: 'claude-haiku-4-5',
        cached: true,
      })),
      daily: vi.fn(async () => 'Shipped SAF-1787.'),
    };
    const handoffs = {
      latest: vi.fn(() => null),
      generate: vi.fn(async () => handoff),
      toMarkdown: (h: Handoff) => `## Handoff\n${h.summary}`,
    };
    ctx.recaps = recaps as unknown as RecapService;
    ctx.handoffs = handoffs as unknown as HandoffService;
    const secrets = createMemorySecretStore({
      ...(o.linearToken === false ? {} : { 'linear.token': 'lin_api_test_123' }),
      'slack.token': 'xoxp-test-123456',
    });
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    const share = createShareService({ ctx, linear, slack });
    const app = p6TestApp();
    registerShareRoutes(app, ctx, { share, linear });
    return { ctx, audit, app, linearApi, slackApi, recaps, handoffs };
  }

  it('previews a redacted Linear recap comment, then posts the confirmed text', async () => {
    const s = setup();
    const first = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'recap', sessionPk: 'claude:s1' },
    });
    expect(first.status).toBe(409);
    const body = (await first.json()) as ErrBody;
    expect(body.error.details?.summary).toContain('SAF-1787');
    expect(body.error.details?.preview).toBe(
      '**Session recap — SAF-1787 SLA weekends**\n\nRan tests with «redacted:github»',
    );
    expect(s.linearApi.comments).toEqual([]);

    const ok = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'text', text: body.error.details?.preview },
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(s.linearApi.comments).toEqual([{ issueId: 'id-SAF-1787', body: body.error.details?.preview }]);
    expect(s.audit.list({ action: 'linear.comment' })[0]).toMatchObject({
      actor: 'user',
      target: 'SAF-1787',
      result: 'ok',
    });
  });

  it('uses the handoff markdown', async () => {
    const s = setup();
    const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'handoff', sessionPk: 'claude:s1' },
    });
    expect(((await res.json()) as ErrBody).error.details?.preview).toBe('## Handoff\nWeekends excluded');
    expect(s.handoffs.generate).toHaveBeenCalledWith('claude:s1');
  });

  it('posts the daily update to the configured channel', async () => {
    expect(
      (
        await send(setup().app, 'POST', '/api/slack/post', {
          source: { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' },
        })
      ).status,
    ).toBe(400);
    const s = setup({ config: { connectors: { slack: { dailyChannel: 'C0DAILY01' } } } });
    const src = { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' };
    const preview = (
      (await (await send(s.app, 'POST', '/api/slack/post', { source: src })).json()) as ErrBody
    ).error.details?.preview;
    expect(preview).toBe('**Daily update — wakecap — 2026-09-17**\n\nShipped SAF-1787.');
    const ok = await send(s.app, 'POST', '/api/slack/post', {
      source: { kind: 'text', text: preview },
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(s.slackApi.posts).toEqual([{ channel: 'C0DAILY01', text: preview }]);
    expect(s.audit.list({ action: 'slack.post' })[0]).toMatchObject({ target: 'C0DAILY01', result: 'ok' });
  });

  it('creates a follow-up ticket in the session ticket team, assigned to me', async () => {
    const s = setup();
    const body = { sessionPk: 'claude:s1', title: 'Handle holidays too', description: 'Also DB_PASSWORD=x' };
    const first = await send(s.app, 'POST', '/api/linear/follow-up', body);
    expect(first.status).toBe(409);
    expect(((await first.json()) as ErrBody).error.details?.preview).toContain(
      'DB_PASSWORD=«redacted:secret»',
    );
    const ok = await send(s.app, 'POST', '/api/linear/follow-up', { ...body, confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ identifier: 'SAF-2001', assignee: 'Test User' });
    const created = s.linearApi.created[0];
    expect(created?.teamId).toBe('team-saf');
    expect(created?.description).toContain('### Context');
    expect(created?.description).toContain('`claude:s1`');
    expect(created?.description).not.toContain('ghp_');
    expect(s.audit.list({ action: 'linear.issue.create' })[0]?.result).toBe('ok');
  });

  it('only shares plan files from the plan roots', async () => {
    const s = setup();
    const inside = join(s.ctx.paths.claudeHome, 'plans', 'sla.md');
    mkdirSync(join(s.ctx.paths.claudeHome, 'plans'), { recursive: true });
    writeFileSync(inside, '# Plan\n1. exclude weekends\n');
    const outside = join(s.ctx.paths.orcHome, 'secret.md');
    writeFileSync(outside, 'nope');
    const bad = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'plan', planPath: outside },
    });
    expect(bad.status).toBe(403);
    const good = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'plan', planPath: inside },
    });
    expect(((await good.json()) as ErrBody).error.details?.preview).toBe('# Plan\n1. exclude weekends');
  });

  it('maps connector failures and audits them', async () => {
    const s = setup({ linearToken: false });
    const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'text', text: 'hi' },
      confirm: true,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrBody).error.code).toBe('unauthenticated');
    expect(s.audit.list({ action: 'linear.comment' })[0]?.result).toBe('error');
  });

  it('looks up issues and validates identifiers', async () => {
    const s = setup();
    expect(await (await send(s.app, 'GET', '/api/linear/issues/SAF-1787')).json()).toMatchObject({
      title: 'Title of SAF-1787',
    });
    expect((await send(s.app, 'GET', '/api/linear/issues/SAF-404')).status).toBe(404);
    expect((await send(s.app, 'GET', '/api/linear/issues/not-an-id')).status).toBe(400);
  });

  // ---------------------------------------------------------------------------------------------
  // Added beyond the plan (security): redact → confirm → audit, checked at the fake API boundary.
  // A secret in the source text must never reach Linear or Slack, whether or not the client
  // re-sends the preview, and nothing is posted or audited as a post before `confirm: true`.
  // ---------------------------------------------------------------------------------------------
  describe('redact → confirm → audit', () => {
    const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const XOXP = 'xoxp-1234-5678-abcd';
    const secretText = `deploy with ${GH} and ${XOXP} then DB_PASSWORD=hunter2`;
    const leaks = (s: string) => [GH, XOXP, 'hunter2'].filter((x) => s.includes(x));

    it('answers 409 confirmation_required with a redacted preview on every post route, and posts nothing', async () => {
      const s = setup({ config: { connectors: { slack: { dailyChannel: 'C0DAILY01' } } } });
      const probes: Array<[string, unknown]> = [
        ['/api/linear/issues/SAF-1787/comment', { source: { kind: 'text', text: secretText } }],
        ['/api/slack/post', { source: { kind: 'text', text: secretText } }],
        ['/api/linear/follow-up', { sessionPk: 'claude:s1', title: 'Rotate keys', description: secretText }],
      ];
      for (const [path, body] of probes) {
        const res = await send(s.app, 'POST', path, body);
        expect({ path, status: res.status }).toEqual({ path, status: 409 });
        const raw = await res.text();
        expect({ path, leaks: leaks(raw) }).toEqual({ path, leaks: [] });
        const err = (JSON.parse(raw) as ErrBody).error;
        expect(err.code).toBe('confirmation_required');
        expect(err.details?.summary).toEqual(expect.any(String));
        expect(err.details?.preview).toContain('«redacted:github»');
        expect(err.details?.preview).toContain('«redacted:slack»');
        expect(err.details?.preview).toContain('DB_PASSWORD=«redacted:secret»');
      }
      expect(s.linearApi.comments).toEqual([]);
      expect(s.linearApi.created).toEqual([]);
      expect(s.slackApi.posts).toEqual([]);
      for (const action of ['linear.comment', 'linear.issue.create', 'slack.post']) {
        expect(s.audit.list({ action })).toEqual([]);
      }
    });

    it('treats confirm: false like a missing confirm', async () => {
      const s = setup();
      const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
        source: { kind: 'text', text: 'hello' },
        confirm: false,
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrBody).error.code).toBe('confirmation_required');
      expect(s.linearApi.comments).toEqual([]);
    });

    it('redacts a confirmed Linear comment before it reaches the API, and audits it without the secret', async () => {
      const s = setup();
      const ok = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
        source: { kind: 'text', text: secretText },
        confirm: true,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(s.linearApi.comments).toHaveLength(1);
      const sent = s.linearApi.comments[0]?.body ?? '';
      expect(leaks(sent)).toEqual([]);
      expect(sent).toContain('«redacted:github»');
      const entries = s.audit.list({ action: 'linear.comment' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor: 'user', target: 'SAF-1787', result: 'ok', error: null });
      expect(entries[0]?.params).toMatchObject({ chars: sent.length, preview: sent });
      expect(leaks(JSON.stringify(entries))).toEqual([]);
    });

    it('redacts a confirmed Slack post before it reaches the API, and audits it without the secret', async () => {
      const s = setup();
      const ok = await send(s.app, 'POST', '/api/slack/post', {
        channel: 'C0TEAM001',
        source: { kind: 'text', text: secretText },
        confirm: true,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ts: expect.any(String) });
      expect(s.slackApi.posts).toHaveLength(1);
      expect(s.slackApi.posts[0]?.channel).toBe('C0TEAM001');
      expect(leaks(s.slackApi.posts[0]?.text ?? '')).toEqual([]);
      const entries = s.audit.list({ action: 'slack.post' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor: 'user', target: 'C0TEAM001', result: 'ok' });
      expect(leaks(JSON.stringify(entries))).toEqual([]);
    });

    it('redacts a confirmed follow-up title and description before they reach the API', async () => {
      const s = setup();
      const ok = await send(s.app, 'POST', '/api/linear/follow-up', {
        sessionPk: 'claude:s1',
        title: `Rotate ${GH}`,
        description: secretText,
        confirm: true,
      });
      expect(ok.status).toBe(200);
      expect(s.linearApi.created).toHaveLength(1);
      const created = s.linearApi.created[0];
      expect(leaks(created?.title ?? '')).toEqual([]);
      expect(leaks(created?.description ?? '')).toEqual([]);
      expect(created?.assigneeId).toBe('user-1');
      const entries = s.audit.list({ action: 'linear.issue.create' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ target: 'SAF', result: 'ok' });
      expect(leaks(JSON.stringify(entries))).toEqual([]);
    });

    it('records a preview of at most 300 chars in the audit entry, never the full body', async () => {
      const s = setup();
      const text = `${'a'.repeat(400)} TAIL-MARKER`;
      const ok = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
        source: { kind: 'text', text },
        confirm: true,
      });
      expect(ok.status).toBe(200);
      const entry = s.audit.list({ action: 'linear.comment' })[0];
      expect(entry?.params.chars).toBe(text.length);
      expect(String(entry?.params.preview).length).toBeLessThanOrEqual(300);
      expect(JSON.stringify(entry)).not.toContain('TAIL-MARKER');
    });

    it('caps a composed share at 20,000 chars', async () => {
      const s = setup();
      const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
        source: { kind: 'text', text: 'b'.repeat(20000) },
      });
      expect(res.status).toBe(409);
      const preview = ((await res.json()) as ErrBody).error.details?.preview ?? '';
      expect(preview.length).toBeLessThanOrEqual(20000 + '\n\n…(truncated)'.length);
    });

    it('records a remote device as the actor of a confirmed post', async () => {
      const s = setup();
      const ok = await send(
        s.app,
        'POST',
        '/api/linear/issues/SAF-1787/comment',
        { source: { kind: 'text', text: 'from my phone' }, confirm: true },
        { 'x-test-remote': 'd1' },
      );
      expect(ok.status).toBe(200);
      expect(s.audit.list({ action: 'linear.comment' })[0]).toMatchObject({
        actor: 'remote',
        actorDetail: 'Test phone (me@example.com)',
        result: 'ok',
      });
    });

    it('audits a failed Slack post as an error and posts nothing', async () => {
      const s = setup();
      s.slackApi.control.failAuth = true;
      const res = await send(s.app, 'POST', '/api/slack/post', {
        channel: 'C0TEAM001',
        source: { kind: 'text', text: 'hi' },
        confirm: true,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrBody).error.code).toBe('unauthenticated');
      expect(s.slackApi.posts).toEqual([]);
      expect(s.audit.list({ action: 'slack.post' })[0]?.result).toBe('error');
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Added beyond the plan (shipped conventions): the share routes are mounted through the one
// registration path (`registerAllRoutes`, via `createApp`), need the loopback token, are declared
// in the route census, and every post is an audited route recorded by the service exactly once.
// -----------------------------------------------------------------------------------------------
describe('share routes on the real app', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function realApp() {
    const secrets = createMemorySecretStore({
      'linear.token': 'lin_api_test_123',
      'slack.token': 'xoxp-test-123456',
    });
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    const ctx = createTestContext({ secrets, linear, slack });
    ctx.share = createShareService({ ctx, linear, slack });
    cleanups.push(() => ctx.dispose());
    const app = createApp({ ctx, token: P3_TOKEN, port: () => 4317, env: {} });
    const call = (method: string, path: string, o: { body?: unknown; token?: string | null } = {}) => {
      const headers: Record<string, string> = { host: '127.0.0.1:4317' };
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
    return { ctx, app, call, linearApi, slackApi };
  }

  it('answers 401 without the token on every share route, and posts nothing', async () => {
    const t = realApp();
    const text = { source: { kind: 'text', text: 'hi' }, confirm: true };
    const probes: Array<[string, string, unknown?]> = [
      ['GET', '/api/linear/issues/SAF-1787'],
      ['POST', '/api/linear/issues/SAF-1787/comment', text],
      ['POST', '/api/linear/follow-up', { sessionPk: 'claude:s1', title: 'Follow up', confirm: true }],
      ['POST', '/api/slack/post', { ...text, channel: 'C0TEAM001' }],
    ];
    for (const [method, path, body] of probes) {
      const res = await t.call(method, path, { token: null, body });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
    expect(t.linearApi.comments).toEqual([]);
    expect(t.linearApi.created).toEqual([]);
    expect(t.linearApi.issueCalls).toEqual([]);
    expect(t.slackApi.posts).toEqual([]);
  });

  it('serves the issue lookup through registerAllRoutes', async () => {
    const t = realApp();
    const res = await t.call('GET', '/api/linear/issues/SAF-1787');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identifier: 'SAF-1787', title: 'Title of SAF-1787' });
  });

  it('audits a confirmed post exactly once through the real middleware, and a 409 not at all', async () => {
    const t = realApp();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const first = await t.call('POST', '/api/linear/issues/SAF-1787/comment', {
      body: { source: { kind: 'text', text: `token ${secret}` } },
    });
    expect(first.status).toBe(409);
    expect(await first.text()).not.toContain(secret);
    expect(t.ctx.audit?.list({ action: 'linear.comment' }) ?? []).toEqual([]);

    const ok = await t.call('POST', '/api/linear/issues/SAF-1787/comment', {
      body: { source: { kind: 'text', text: `token ${secret}` }, confirm: true },
    });
    expect(ok.status).toBe(200);
    expect(t.linearApi.comments).toHaveLength(1);
    expect(t.linearApi.comments[0]?.body).not.toContain(secret);
    const entries = t.ctx.audit?.list({ action: 'linear.comment' }) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ target: 'SAF-1787', result: 'ok' });
    expect(JSON.stringify(entries)).not.toContain(secret);

    const slack = await t.call('POST', '/api/slack/post', {
      body: { channel: 'C0TEAM001', source: { kind: 'text', text: 'shipped' }, confirm: true },
    });
    expect(slack.status).toBe(200);
    expect(t.ctx.audit?.list({ action: 'slack.post' }) ?? []).toHaveLength(1);
  });

  it('declares every share route in the census and every post in the audit lists', () => {
    for (const key of [
      'GET /api/linear/issues/:identifier',
      'POST /api/linear/issues/:identifier/comment',
      'POST /api/linear/follow-up',
      'POST /api/slack/post',
    ]) {
      expect(CENSUS[key], key).toBeDefined();
    }
    expect(REGISTRAR_FILES).toContain('apps/daemon/src/http/routes/share.ts');
    const posts: Array<[string, string]> = [
      ['/api/linear/issues/SAF-1787/comment', 'linear.comment'],
      ['/api/linear/follow-up', 'linear.issue.create'],
      ['/api/slack/post', 'slack.post'],
    ];
    for (const [path, action] of posts) {
      const hit = matchAuditedRoute('POST', path);
      expect(hit, path).not.toBeNull();
      expect(hit?.route.recordedBy, path).toBe('service');
      const a = hit?.route.action;
      expect(typeof a === 'function' ? a({}) : a, path).toBe(action);
    }
    // The issue lookup is a read, not an action.
    expect(matchAuditedRoute('GET', '/api/linear/issues/SAF-1787')).toBeNull();
  });
});
