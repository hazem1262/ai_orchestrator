import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import type { HeadlessRunOptions } from '../../src/services/automations/headless.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createTemplateRegistry } from '../../src/services/templates.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
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

/** Real template registry: `wf-review-pr` needs `prUrl` and throws `template_var_missing` without it. */
function setup() {
  const cfg = testConfig({ automations: { enabled: true } });
  const prompts: string[] = [];
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox: fakeInbox(),
    audit: fakeAudit(),
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    recaps: fakeRecaps(),
    worktrees: fakeWorktrees(),
    pty: createFakePty(),
    launcher: fakeLauncher(),
    templates: createTemplateRegistry(),
  });
  ctx.automations = createAutomationService({
    ctx,
    runner: async (r: HeadlessRunOptions) => {
      prompts.push(r.prompt);
      mkdirSync(dirname(r.logFile), { recursive: true });
      writeFileSync(
        r.logFile,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n',
      );
      return {
        sessionId: r.sessionId ?? 's',
        costUsd: 0.1,
        durationMs: 1,
        numTurns: 1,
        resultText: 'Reviewed',
        isError: false,
        subtype: 'success',
        timedOut: false,
        exitCode: 0,
        events: 1,
        stderrTail: '',
      };
    },
  });
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
  const t = { call, prompts, ctx };
  return t;
}

async function createReviewAutomation(t: ReturnType<typeof setup>): Promise<string> {
  const res = await t.call('/api/automations', 'POST', {
    name: 'Review PR',
    enabled: true,
    trigger: { type: 'manual' },
    action: {
      templateId: 'wf-review-pr',
      projectId: 'wakecap',
      useWorktree: false,
      headless: true,
      timeoutMin: 5,
      planApproval: false,
    },
    budgetUsd: 3,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const PR = 'https://github.com/o/r/pull/1';

describe('POST /api/automations/:id/run with vars', () => {
  it('passes body vars to the run so a template that needs prUrl succeeds', async () => {
    const t = setup();
    const id = await createReviewAutomation(t);
    const started = await t.call(`/api/automations/${id}/run`, 'POST', { vars: { prUrl: PR } });
    expect(started.status).toBe(202);
    const run = (await started.json()) as { id: string; vars: Record<string, string>; error: string | null };
    expect(run.vars).toEqual({ prUrl: PR });
    const done = await t.ctx.automations?.waitFor(run.id);
    expect(done?.error ?? null).toBeNull();
    expect(done?.status).toBe('success');
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain(PR);
  });

  it('rejects an unknown var name with 400 validation_failed', async () => {
    const t = setup();
    const id = await createReviewAutomation(t);
    const res = await t.call(`/api/automations/${id}/run`, 'POST', { vars: { bogus: 'x' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
    expect(t.prompts).toHaveLength(0);
  });

  it('rejects a non-string var value with 400 validation_failed', async () => {
    const t = setup();
    const id = await createReviewAutomation(t);
    const res = await t.call(`/api/automations/${id}/run`, 'POST', { vars: { prUrl: 5 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
    expect(t.prompts).toHaveLength(0);
  });
});
