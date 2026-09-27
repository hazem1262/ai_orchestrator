import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import type { HeadlessRunOptions } from '../../src/services/automations/headless.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createSuggestionService } from '../../src/services/automations/suggestions.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { withService?: boolean } = {}) {
  let cfg = testConfig({ automations: { enabled: true } });
  const audit = fakeAudit();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    inbox: fakeInbox(),
    audit,
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    recaps: fakeRecaps(),
    worktrees: fakeWorktrees(),
    pty: createFakePty(),
    launcher: fakeLauncher(),
    templates: fakeTemplates({ t: 'Tidy the README' }),
  });
  if (o.withService !== false) {
    ctx.automations = createAutomationService({
      ctx,
      runner: async (r: HeadlessRunOptions) => {
        mkdirSync(dirname(r.logFile), { recursive: true });
        writeFileSync(
          r.logFile,
          '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n',
        );
        return {
          sessionId: r.resumeSessionId ?? r.sessionId ?? 's',
          costUsd: 0.1,
          durationMs: 1,
          numTurns: 1,
          resultText: r.permissionMode === 'plan' ? 'Plan: tidy' : 'Tidied',
          isError: false,
          subtype: 'success',
          timedOut: false,
          exitCode: 0,
          events: 1,
          stderrTail: '',
        };
      },
    });
    ctx.suggestions = createSuggestionService({ ctx });
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
  return { call, audit, getCfg: () => cfg, ctx };
}

const input = (planApproval = false) => ({
  name: 'Tidy docs',
  enabled: true,
  trigger: { type: 'manual' },
  action: {
    templateId: 't',
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 5,
    planApproval,
  },
  budgetUsd: 3,
});

describe('/api/automations', () => {
  it('creates disabled automations, lists them with stats and toggles them', async () => {
    const t = setup();
    const created = await t.call('/api/automations', 'POST', input());
    expect(created.status).toBe(201);
    const a = (await created.json()) as { id: string; enabled: boolean };
    expect(a.enabled).toBe(false);
    const list = (await (await t.call('/api/automations')).json()) as Array<{
      id: string;
      stats: { total: number };
    }>;
    expect(list).toMatchObject([{ id: a.id, stats: { total: 0 } }]);
    const on = (await (
      await t.call(`/api/automations/${a.id}/enabled`, 'POST', { enabled: true })
    ).json()) as { enabled: boolean };
    expect(on.enabled).toBe(true);
    expect((await t.call(`/api/automations/${a.id}`)).status).toBe(200);
    expect((await t.call('/api/automations/nope')).status).toBe(404);
  });

  it('rejects invalid bodies', async () => {
    const t = setup();
    const res = await t.call('/api/automations', 'POST', { ...input(), budgetUsd: -1 });
    expect(res.status).toBe(400);
  });

  it('runs now, exposes the run and a redacted log', async () => {
    const t = setup();
    const a = (await (await t.call('/api/automations', 'POST', input())).json()) as { id: string };
    const started = await t.call(`/api/automations/${a.id}/run`, 'POST', {});
    expect(started.status).toBe(202);
    const run = (await started.json()) as { id: string };
    await t.ctx.automations?.waitFor(run.id);
    const detail = (await (await t.call(`/api/automations/runs/${run.id}`)).json()) as { status: string };
    expect(detail.status).toBe('success');
    expect(await (await t.call(`/api/automations/runs/${run.id}/log`)).json()).toEqual({ lines: ['done'] });
    const runs = (await (await t.call(`/api/automations/${a.id}/runs`)).json()) as unknown[];
    expect(runs).toHaveLength(1);
  });

  it('needs confirmation to delete and to approve', async () => {
    const t = setup();
    const a = (await (await t.call('/api/automations', 'POST', input(true))).json()) as { id: string };
    const del = await t.call(`/api/automations/${a.id}`, 'DELETE', {});
    expect(del.status).toBe(409);
    expect(
      ((await del.json()) as { error: { code: string; details: { summary: string } } }).error,
    ).toMatchObject({
      code: 'confirmation_required',
      details: { summary: expect.stringContaining('Tidy docs') },
    });

    const run = (await (await t.call(`/api/automations/${a.id}/run`, 'POST', {})).json()) as { id: string };
    await t.ctx.automations?.waitFor(run.id);
    expect((await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', {})).status).toBe(409);
    const approved = await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', { confirm: true });
    expect(approved.status).toBe(202);
    expect(((await approved.json()) as { status: string }).status).toBe('running');
    const done = await t.ctx.automations?.waitFor(run.id);
    expect(done?.status).toBe('success');
    const again = await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', { confirm: true });
    expect(again.status).toBe(409);
    expect((await t.call(`/api/automations/runs/${run.id}/reject`, 'POST', {})).status).toBe(409);
    expect((await t.call(`/api/automations/${a.id}`, 'DELETE', { confirm: true })).status).toBe(200);
  });

  it('updates the settings through updateConfig and audits it', async () => {
    const t = setup();
    expect(await (await t.call('/api/automations/settings')).json()).toEqual({
      enabled: true,
      maxConcurrent: 2,
      suggestionsEnabled: false,
    });
    const res = await t.call('/api/automations/settings', 'PATCH', {
      enabled: false,
      maxConcurrent: 3,
      suggestionsEnabled: true,
    });
    expect(await res.json()).toEqual({ enabled: false, maxConcurrent: 3, suggestionsEnabled: true });
    expect(t.getCfg().automations).toMatchObject({
      enabled: false,
      maxConcurrent: 3,
      suggestions: { enabled: true },
    });
    expect(
      t.audit.entries.some((e) => e.action === 'settings.update' && e.target === 'config:automations'),
    ).toBe(true);
  });

  it('lists suggestions and 404s unknown ones', async () => {
    const t = setup();
    expect(await (await t.call('/api/automations/suggestions?state=new')).json()).toEqual([]);
    expect((await t.call('/api/automations/suggestions?state=bogus')).status).toBe(400);
    expect((await t.call('/api/automations/suggestions/x/dismiss', 'POST', {})).status).toBe(404);
  });

  it('answers 409 not_enabled when the service is not wired', async () => {
    const t = setup({ withService: false });
    const res = await t.call('/api/automations');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_enabled');
  });
});
