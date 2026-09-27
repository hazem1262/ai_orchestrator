import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { createSupervisor } from '../../src/services/supervisor/supervisor.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(withService = true) {
  let cfg = testConfig({ supervisor: { enabled: true } });
  const pty = createFakePty();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    pty,
    inbox: fakeInbox(),
    audit: fakeAudit(),
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    sessions: fakeSessions([
      makeSession({ id: 's1', live: makeLive({ status: 'waiting', ptyId: 'pty-1' }) }),
    ]),
  });
  if (withService) {
    ctx.supervisor = createSupervisor({
      ctx,
      lastAssistantText: async () => 'Should I continue?',
      classifier: async (i) => ({
        output: { decision: 'answer', answer: 'ok', confidence: 0.95, reason: 'routine' },
        costUsd: 0.001,
        model: i.model,
        durationMs: 5,
      }),
    });
  }
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: {
        'x-orc-token': TEST_TOKEN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, pty, getCfg: () => cfg };
}

describe('/api/supervisor', () => {
  it('reports status and patches the settings', async () => {
    const t = setup();
    expect(await (await t.call('/api/supervisor/status')).json()).toMatchObject({
      enabled: true,
      answeredLastHour: 0,
      quiet: false,
    });
    const patched = await t.call('/api/supervisor/settings', 'PATCH', {
      enabled: false,
      confidenceThreshold: 0.95,
      quietHours: { start: '22:00', end: '08:00' },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      enabled: false,
      confidenceThreshold: 0.95,
      quiet: expect.any(Boolean),
    });
    expect(t.getCfg().supervisor.quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect((await t.call('/api/supervisor/settings', 'PATCH', { confidenceThreshold: 5 })).status).toBe(400);
  });

  it('manages targets and rules', async () => {
    const t = setup();
    const target = await t.call('/api/supervisor/targets', 'PUT', {
      targetType: 'project',
      targetId: 'wakecap',
      enabled: true,
    });
    expect(await target.json()).toEqual({ targetType: 'project', targetId: 'wakecap', enabled: true });
    expect(((await (await t.call('/api/supervisor/targets')).json()) as unknown[]).length).toBe(1);

    const rule = (await (
      await t.call('/api/supervisor/rules', 'POST', {
        kind: 'allow',
        pattern: 'ship it\\?$',
        intent: 'continue',
        answer: 'Yes, ship it.',
      })
    ).json()) as { id: string };
    expect(((await (await t.call('/api/supervisor/rules')).json()) as unknown[]).length).toBe(1);
    expect((await t.call(`/api/supervisor/rules/${rule.id}`, 'DELETE', {})).status).toBe(409);
    expect((await t.call(`/api/supervisor/rules/${rule.id}`, 'DELETE', { confirm: true })).status).toBe(200);
    expect((await t.call('/api/supervisor/rules/missing', 'DELETE', { confirm: true })).status).toBe(404);
  });

  it('evaluates a session, lists decisions and takes feedback', async () => {
    const t = setup();
    await t.call('/api/supervisor/targets', 'PUT', {
      targetType: 'project',
      targetId: 'wakecap',
      enabled: true,
    });
    const decision = (await (await t.call('/api/supervisor/evaluate/claude/s1', 'POST', {})).json()) as {
      id: string;
      decision: string;
    };
    expect(decision.decision).toBe('answer');
    expect(t.pty.sent).toHaveLength(1);
    const list = (await (
      await t.call('/api/supervisor/decisions?sessionPk=claude:s1&limit=10')
    ).json()) as unknown[];
    expect(list).toHaveLength(1);
    const rule = (await (
      await t.call(`/api/supervisor/decisions/${decision.id}/wrong`, 'POST', {})
    ).json()) as { kind: string; source: string };
    expect(rule).toMatchObject({ kind: 'deny', source: 'feedback' });
    expect((await t.call('/api/supervisor/decisions/nope/wrong', 'POST', {})).status).toBe(404);
    expect((await t.call('/api/supervisor/evaluate/claude/missing', 'POST', {})).status).toBe(404);
  });

  it('answers 409 not_enabled without the service', async () => {
    const t = setup(false);
    const res = await t.call('/api/supervisor/status');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_enabled');
  });
});
