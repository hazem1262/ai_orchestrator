import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { AUTOMATION_DISALLOWED_TOOLS } from '../../src/services/automations/guardrails.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createCompareService } from '../../src/services/compare/compare.ts';
import { createSupervisor } from '../../src/services/supervisor/supervisor.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
  fakeSessions,
  fakeShip,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
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

const automation = {
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'manual' as const },
  action: {
    templateId: 'fix',
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 5,
    planApproval: false,
  },
  budgetUsd: 5,
};

function harness(o: { cfg?: Record<string, unknown>; usageOk?: boolean } = {}) {
  let cfg = testConfig(o.cfg ?? {});
  const audit = fakeAudit();
  const inbox = fakeInbox();
  const pty = createFakePty();
  const ship = fakeShip();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    audit,
    inbox,
    pty,
    ship,
    launcher: fakeLauncher(),
    worktrees: fakeWorktrees(),
    recaps: fakeRecaps(),
    usage: fakeUsage({ ok: o.usageOk ?? true }),
    denyList: fakeDenyList(),
    templates: fakeTemplates({ fix: 'Fix the failing check', danger: 'deploy to production' }),
    sessions: fakeSessions([
      makeSession({ id: 's1', live: makeLive({ status: 'waiting', ptyId: 'pty-1' }) }),
    ]),
  });
  const runnerCalls: string[] = [];
  ctx.automations = createAutomationService({
    ctx,
    runner: async (r) => {
      runnerCalls.push(r.prompt);
      return {
        sessionId: r.sessionId ?? 's',
        costUsd: 0.1,
        durationMs: 1,
        numTurns: 1,
        resultText: 'done',
        isError: false,
        subtype: 'success',
        timedOut: false,
        exitCode: 0,
        events: 1,
        stderrTail: '',
      };
    },
  });
  ctx.supervisor = createSupervisor({
    ctx,
    lastAssistantText: async () => 'Should I continue?',
    classifier: async (i) => ({
      output: { decision: 'answer', answer: 'ok', confidence: 0.99, reason: 'routine' },
      costUsd: 0.001,
      model: i.model,
      durationMs: 1,
    }),
  });
  ctx.compare = createCompareService({ ctx });
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
  return { ctx, app, call, audit, inbox, pty, ship, runnerCalls, getCfg: () => cfg };
}

describe('M7 exit: everything can be turned off', () => {
  it('ships with automations, the supervisor and AGNC off by default', () => {
    const cfg = OrcConfig.parse({});
    expect(cfg.automations.enabled).toBe(false);
    expect(cfg.automations.suggestions.enabled).toBe(false);
    expect(cfg.supervisor.enabled).toBe(false);
    expect(cfg.agnc.enabled).toBe(false);
  });

  it('runs nothing while the master switches are off', async () => {
    const t = harness();
    t.ctx.automations?.save(automation);
    expect((await t.ctx.automations?.runNow('a1'))?.status).toBe('denied');
    expect(t.runnerCalls).toHaveLength(0);

    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(false);
    const decision = await t.ctx.supervisor?.evaluate('claude:s1');
    expect(decision?.sent).toBe(false);
    expect(t.pty.sent).toHaveLength(0);
  });

  it('turns a single automation and a single session off again', async () => {
    const t = harness({ cfg: { automations: { enabled: true }, supervisor: { enabled: true } } });
    t.ctx.automations?.save(automation);
    expect((await t.ctx.automations?.runNow('a1'))?.status).toBe('success');
    t.ctx.automations?.setEnabled('a1', false);
    expect(t.ctx.automations?.get('a1')?.enabled).toBe(false);

    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(true);
    t.ctx.supervisor?.setTarget({ targetType: 'session', targetId: 'claude:s1', enabled: false });
    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(false);
  });
});

describe('M7 exit: budgets and the deny-list are enforced', () => {
  it('refuses automations over budget and deny-listed prompts, and compare over budget', async () => {
    const over = harness({ cfg: { automations: { enabled: true } }, usageOk: false });
    over.ctx.automations?.save(automation);
    expect((await over.ctx.automations?.runNow('a1'))?.status).toBe('over_budget');
    await expect(
      over.ctx.compare?.launch({
        source: 'claude',
        projectId: 'wakecap',
        cwd: '/tmp',
        prompt: 'x',
        vars: {},
        planApproval: false,
        worktree: { repo: '/tmp/r', base: 'main', type: 'feat', slug: 's' },
        compare: [{ source: 'claude' }, { source: 'codex' }],
      }),
    ).rejects.toMatchObject({ code: 'over_budget' });

    const denied = harness({ cfg: { automations: { enabled: true } } });
    denied.ctx.automations?.save({ ...automation, action: { ...automation.action, templateId: 'danger' } });
    expect((await denied.ctx.automations?.runNow('a1'))?.status).toBe('denied');
    expect(denied.runnerCalls).toHaveLength(0);
  });

  it('never allows merge, deploy or prod tools in an automation run', () => {
    for (const tool of [
      'Bash(gh pr merge *)',
      'Bash(git push --force *)',
      'Bash(kubectl *)',
      'Bash(terraform *)',
    ]) {
      expect(AUTOMATION_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('escalates instead of answering a deny-listed supervisor question', async () => {
    const t = harness({ cfg: { supervisor: { enabled: true } } });
    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    const svc = createSupervisor({
      ctx: t.ctx,
      lastAssistantText: async () => 'Should I deploy to production?',
      classifier: async () => {
        throw new Error('the classifier must not be called');
      },
    });
    expect((await svc.evaluate('claude:s1')).decision).toBe('escalate');
    expect(t.pty.sent).toHaveLength(0);
  });
});

describe('M7 exit: every action is audited', () => {
  it('records automation, supervisor and compare actions with their actor', async () => {
    const t = harness({ cfg: { automations: { enabled: true }, supervisor: { enabled: true } } });
    t.ctx.automations?.save(automation);
    await t.ctx.automations?.runNow('a1');
    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    await t.ctx.supervisor?.evaluate('claude:s1');

    const byAction = new Map(t.audit.entries.map((e) => [e.action, e]));
    expect(byAction.get('automation.run')?.actor).toBe('automation');
    expect(byAction.get('supervisor.answer')?.actor).toBe('supervisor');
    expect(byAction.has('settings.update')).toBe(true);
    expect(t.ship.calls).not.toContain('merge');
  });

  it('keeps every phase 7 write route inside the audit coverage rules', async () => {
    const t = harness();
    const { AUDITED_ROUTES, NON_ACTION_ROUTES, matchAuditedRoute } = await import(
      '../../src/http/audit-middleware.ts'
    );
    expect(AUDITED_ROUTES.length).toBeGreaterThan(0);
    // Same placeholder fill as audit.coverage.test.ts: `:source` must be a real source for the SRC patterns.
    const fill = (p: string) =>
      p.replace(/:([A-Za-z]+)(?:\{[^}]*\})?/g, (_m, name: string) => (name === 'source' ? 'claude' : 'x'));
    const p7 = ['/api/automations', '/api/compare', '/api/supervisor', '/api/agnc', '/api/connectors/agnc'];
    const writes = t.app.routes.filter(
      (r) => p7.some((p) => r.path.startsWith(p)) && !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(r.method),
    );
    expect(writes.length).toBeGreaterThan(20);
    const missing = writes
      .filter(
        (r) =>
          !matchAuditedRoute(r.method, fill(r.path)) &&
          !NON_ACTION_ROUTES.some((n) => n.method === r.method && n.path === r.path),
      )
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
