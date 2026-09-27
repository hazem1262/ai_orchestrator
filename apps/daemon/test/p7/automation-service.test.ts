import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Automation } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../../src/db/repos/automations.ts';
import { inboxDedupeKey } from '../../src/inbox/engine.ts';
import { AUTOMATION_PREAMBLE } from '../../src/services/automations/guardrails.ts';
import type {
  HeadlessRunner,
  HeadlessRunOptions,
  HeadlessRunResult,
} from '../../src/services/automations/headless.ts';
import { createAutomationService, findPrUrl, monthStartIso } from '../../src/services/automations/service.ts';
import { ServiceError } from '../../src/services/errors.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeRecaps,
  fakeShip,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const okResult = (o: HeadlessRunOptions, over: Partial<HeadlessRunResult> = {}): HeadlessRunResult => ({
  sessionId: o.resumeSessionId ?? o.sessionId ?? 's',
  costUsd: 0.5,
  durationMs: 1000,
  numTurns: 3,
  resultText: 'Opened https://github.com/example-org/svc/pull/12',
  isError: false,
  subtype: 'success',
  timedOut: false,
  exitCode: 0,
  events: 5,
  stderrTail: '',
  ...over,
});

const auto = (over: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'manual' },
  action: {
    templateId: 'fix-ci',
    projectId: 'wakecap',
    useWorktree: true,
    headless: true,
    timeoutMin: 5,
    planApproval: false,
  },
  budgetUsd: 10,
  ...over,
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { cfg?: Record<string, unknown>; runner?: HeadlessRunner; usageOk?: boolean } = {}) {
  const cfg = testConfig({ automations: { enabled: true, maxConcurrent: 2 }, ...o.cfg });
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const worktrees = fakeWorktrees();
  const ship = fakeShip();
  const pty = createFakePty();
  const recaps = fakeRecaps();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox,
    audit,
    worktrees,
    ship,
    pty,
    recaps,
    launcher: undefined,
    usage: fakeUsage({ ok: o.usageOk ?? true }),
    denyList: fakeDenyList(),
    templates: fakeTemplates({
      'fix-ci': 'Fix the failing check on {{prUrl}}',
      danger: 'deploy the api to production',
    }),
  });
  const calls: HeadlessRunOptions[] = [];
  const runner: HeadlessRunner =
    o.runner ??
    (async (opts) => {
      calls.push(opts);
      return okResult(opts);
    });
  const svc = createAutomationService({ ctx, runner });
  return { ctx, svc, inbox, audit, worktrees, ship, pty, recaps, calls };
}

describe('AutomationService.runNow (headless)', () => {
  it('runs in a new worktree and reports to inbox and audit', async () => {
    const t = setup();
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('success');
    const detail = t.svc.run(run.id);
    expect(detail).toMatchObject({
      costUsd: 0.5,
      prUrl: 'https://github.com/example-org/svc/pull/12',
      summary: 'Fixed the flaky test and opened a draft PR.',
    });
    expect(t.worktrees.created[0]?.branch).toMatch(/^chore\/auto-fix-ci-/);
    const call = t.calls[0];
    expect(call?.cwd).toBe(t.worktrees.created[0]?.path);
    expect(call?.permissionMode).toBe('acceptEdits');
    expect(call?.maxBudgetUsd).toBe(10);
    expect(call?.prompt.startsWith(AUTOMATION_PREAMBLE)).toBe(true);
    expect(call?.prompt).toContain('Fix the failing check on');
    expect(t.recaps.calls).toEqual([detail?.sessionPk]);
    const item = t.inbox.items.find((i) => i.kind === 'automation_result');
    expect(item?.dedupeKey).toBe(
      inboxDedupeKey({ kind: 'automation_result', scope: { domain: 'automation-run', id: run.id } }),
    );
    expect(item?.payload).toMatchObject({
      source: 'claude',
      runId: run.id,
      prUrl: 'https://github.com/example-org/svc/pull/12',
    });
    const entry = t.audit.entries.find((e) => e.action === 'automation.run');
    expect(entry).toMatchObject({ actor: 'automation', actorDetail: 'Fix CI', result: 'ok' });
  });

  it('denies every run while the master switch is off', async () => {
    const t = setup({ cfg: { automations: { enabled: false } } });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('denied');
    expect(t.calls).toHaveLength(0);
    expect(t.worktrees.created).toHaveLength(0);
    expect(t.audit.entries.find((e) => e.action === 'automation.run')?.result).toBe('denied');
    expect(t.inbox.items[0]?.reason).toContain('turned off');
  });

  it('denies a template that asks for a deploy', async () => {
    const t = setup();
    t.svc.save(auto({ action: { ...auto().action, templateId: 'danger' } }));
    expect((await t.svc.runNow('a1')).status).toBe('denied');
    expect(t.calls).toHaveLength(0);
  });

  it('stops on project budget and on the automation monthly budget', async () => {
    const t = setup({ usageOk: false });
    t.svc.save(auto());
    expect((await t.svc.runNow('a1')).status).toBe('over_budget');

    const u = setup();
    u.svc.save(auto({ budgetUsd: 1 }));
    const prior = repo.insertRun(u.ctx.db, {
      id: 'prior',
      automationId: 'a1',
      triggerKey: 'manual:prior',
      triggerSource: 'manual',
      vars: {},
      startedAt: monthStartIso(new Date()),
      status: 'success',
      rerunOf: null,
    });
    expect(prior).not.toBeNull();
    repo.updateRun(u.ctx.db, 'prior', { costUsd: 1 });
    expect((await u.svc.runNow('a1')).status).toBe('over_budget');
    expect(u.calls).toHaveLength(0);
  });

  it('handles a trigger key only once', async () => {
    const t = setup();
    t.svc.save(auto());
    const first = await t.svc.start('a1', { key: 'github:x#1:check_failed:t1', source: 'github', vars: {} });
    const second = await t.svc.start('a1', { key: 'github:x#1:check_failed:t1', source: 'github', vars: {} });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    if (first) await t.svc.waitFor(first.id);
  });

  it('respects the concurrency cap by queueing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: HeadlessRunOptions[] = [];
    const t = setup({
      cfg: { automations: { enabled: true, maxConcurrent: 1 } },
      runner: async (o) => {
        calls.push(o);
        if (calls.length === 1) await gate;
        return okResult(o);
      },
    });
    t.svc.save(auto());
    const r1 = await t.svc.start('a1', { key: 'manual:1', source: 'manual', vars: {} });
    const r2 = await t.svc.start('a1', { key: 'manual:2', source: 'manual', vars: {} });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(t.svc.run(r2?.id ?? '')?.status).toBe('queued');
    release();
    expect((await t.svc.waitFor(r1?.id ?? '')).status).toBe('success');
    expect((await t.svc.waitFor(r2?.id ?? '')).status).toBe('success');
    expect(calls).toHaveLength(2);
  });

  it('marks timeouts and crashes as failed', async () => {
    const t = setup({ runner: async (o) => okResult(o, { isError: true, timedOut: true, resultText: '' }) });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('failed');
    expect(t.svc.run(run.id)?.error).toBe('timed out after 5 min');
    expect(t.audit.entries.find((e) => e.action === 'automation.run')?.result).toBe('error');

    const u = setup({
      runner: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    u.svc.save(auto());
    const crashed = await u.svc.runNow('a1');
    expect(crashed.status).toBe('failed');
    expect(u.svc.run(crashed.id)?.error).toBe('spawn claude ENOENT');
    expect(u.inbox.items.some((i) => i.kind === 'automation_result')).toBe(true);
  });

  it('turns the stream log into readable, redacted lines', async () => {
    const t = setup({
      runner: async (o) => {
        mkdirSync(dirname(o.logFile), { recursive: true });
        writeFileSync(
          o.logFile,
          '{"type":"assistant","message":{"content":[{"type":"text","text":"password=hunter2"}]}}\n',
        );
        return okResult(o);
      },
    });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(t.svc.logLines(run.id)).toEqual(['password=«redacted:secret»']);
  });
});

describe('AutomationService (PTY mode)', () => {
  it('spawns an owned session with restricted tools and finishes when the turn ends', async () => {
    const t = setup();
    t.svc.save(auto({ action: { ...auto().action, headless: false, useWorktree: false } }));
    const started = await t.svc.start('a1', { key: 'manual:pty', source: 'manual', vars: {} });
    await vi.waitFor(() => expect(t.pty.spawned).toHaveLength(1));
    const spawned = t.pty.spawned[0];
    expect(spawned?.args).toContain('--disallowed-tools');
    expect(spawned?.args).toContain('Bash(gh pr merge *)');
    expect(spawned?.args).not.toContain('--dangerously-skip-permissions');
    const pk = spawned?.sessionPk ?? '';
    expect(pk).toMatch(/^claude:/);
    t.ctx.bus.emit({ type: 'session.statusChanged', pk, from: null, to: 'busy' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk, from: 'busy', to: 'idle' });
    const done = await t.svc.waitFor(started?.id ?? '');
    expect(done).toMatchObject({ status: 'success', sessionPk: pk, ptyId: spawned?.id });
    expect(t.pty.killed).toEqual([]);
  });
});

describe('AutomationService management', () => {
  it('validates cron, computes the next run and audits changes', () => {
    const t = setup();
    expect(() => t.svc.save(auto({ trigger: { type: 'cron', cron: 'not a cron' } }))).toThrow(ServiceError);
    const saved = t.svc.save(auto({ trigger: { type: 'cron', cron: '0 9 * * 1-5' } }));
    expect(t.svc.listWithStats()[0]?.nextRunAt).not.toBeNull();
    expect(t.svc.setEnabled(saved.id, false).enabled).toBe(false);
    expect(t.svc.listWithStats()[0]?.nextRunAt).toBeNull();
    const changes: string[] = [];
    t.svc.onChange((id, a) => changes.push(`${id}:${a ? 'saved' : 'removed'}`));
    t.svc.remove(saved.id);
    expect(changes).toEqual(['a1:removed']);
    expect(t.audit.entries.filter((e) => e.action === 'settings.update')).toHaveLength(3);
  });

  it('fails runs left active by a previous daemon', () => {
    const t = setup();
    t.svc.save(auto());
    repo.insertRun(t.ctx.db, {
      id: 'stale',
      automationId: 'a1',
      triggerKey: 'manual:stale',
      triggerSource: 'manual',
      vars: {},
      startedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      rerunOf: null,
    });
    createAutomationService({ ctx: t.ctx, runner: async (o) => okResult(o) });
    expect(repo.getRun(t.ctx.db, 'stale')?.status).toBe('failed');
  });

  it('finds PR links', () => {
    expect(findPrUrl('see https://github.com/example-org/svc/pull/7.')).toBe(
      'https://github.com/example-org/svc/pull/7',
    );
    expect(findPrUrl('no link')).toBeNull();
  });
});

describe('never merge (runtime)', () => {
  it('never calls ShipService.merge, even when the model talks about merging', async () => {
    const t = setup({ runner: async (o) => okResult(o, { resultText: 'Ready to merge: gh pr merge 12' }) });
    t.svc.save(auto());
    await t.svc.runNow('a1');
    expect(t.ship.calls).not.toContain('merge');
    expect(
      readFileSync(new URL('../../src/services/automations/guardrails.ts', import.meta.url), 'utf8'),
    ).toContain("'Bash(gh pr merge *)'");
  });
});
