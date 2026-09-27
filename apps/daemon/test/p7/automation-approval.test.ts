import type { Automation } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { inboxDedupeKey } from '../../src/inbox/engine.ts';
import { APPROVAL_PROMPT } from '../../src/services/automations/guardrails.ts';
import type { HeadlessRunOptions, HeadlessRunResult } from '../../src/services/automations/headless.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { ServiceError } from '../../src/services/errors.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeRecaps,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const planned: Automation = {
  id: 'p1',
  name: 'Implement assigned ticket',
  enabled: true,
  trigger: { type: 'manual' },
  action: {
    templateId: 'impl',
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 10,
    planApproval: true,
  },
  budgetUsd: 10,
};

const planKey = (runId: string): string =>
  inboxDedupeKey({ kind: 'plan_approval', scope: { domain: 'automation-run', id: runId } });

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(planText = 'Plan:\n1. Add the weekend check\n2. Add a test') {
  const cfg = testConfig({ automations: { enabled: true } });
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const usage = fakeUsage();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox,
    audit,
    usage,
    pty: createFakePty(),
    worktrees: fakeWorktrees(),
    recaps: fakeRecaps(),
    denyList: fakeDenyList(),
    launcher: undefined,
    templates: fakeTemplates({ impl: 'Implement {{ticket}}' }),
  });
  const calls: HeadlessRunOptions[] = [];
  const svc = createAutomationService({
    ctx,
    runner: async (o): Promise<HeadlessRunResult> => {
      calls.push(o);
      const plan = o.permissionMode === 'plan';
      return {
        sessionId: o.resumeSessionId ?? o.sessionId ?? 'x',
        costUsd: plan ? 0.25 : 0.75,
        durationMs: 10,
        numTurns: 1,
        resultText: plan ? planText : 'Implemented. https://github.com/example-org/svc/pull/31',
        isError: false,
        subtype: 'success',
        timedOut: false,
        exitCode: 0,
        events: 3,
        stderrTail: '',
      };
    },
  });
  svc.save(planned);
  return { svc, inbox, audit, usage, calls };
}

async function awaitingRun(t: ReturnType<typeof setup>) {
  const started = await t.svc.start('p1', {
    key: 'manual:plan',
    source: 'manual',
    vars: { ticket: 'SAF-9' },
  });
  const run = await t.svc.waitFor(started?.id ?? '');
  expect(run.status).toBe('awaiting_approval');
  return run;
}

describe('automation plan approval', () => {
  it('stops after planning, then resumes the same session on approval', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    expect(t.calls[0]?.permissionMode).toBe('plan');
    const planItem = t.inbox.items.find((i) => i.kind === 'plan_approval');
    expect(planItem).toMatchObject({ dedupeKey: planKey(run.id), ticket: 'SAF-9' });
    expect(planItem?.payload).toMatchObject({ runId: run.id, plan: expect.stringContaining('weekend') });

    const pending = t.svc.approve(run.id);
    expect(t.svc.run(run.id)?.status).toBe('running');
    const done = await pending;
    expect(done).toMatchObject({
      status: 'success',
      costUsd: 1,
      prUrl: 'https://github.com/example-org/svc/pull/31',
    });
    const resume = t.calls[1];
    expect(resume?.resumeSessionId).toBe(t.calls[0]?.sessionId);
    expect(resume?.permissionMode).toBe('acceptEdits');
    expect(resume?.prompt).toBe(APPROVAL_PROMPT);
    expect(t.inbox.resolved).toContain(planKey(run.id));
    expect(t.audit.entries.find((e) => e.action === 'automation.approve')).toMatchObject({
      actor: 'user',
      result: 'ok',
    });
  });

  it('refuses to approve a run that is not waiting', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    await t.svc.approve(run.id);
    await expect(t.svc.approve(run.id)).rejects.toBeInstanceOf(ServiceError);
  });

  it('denies approval when the plan hits the deny-list', async () => {
    const t = setup('Plan:\n1. terraform apply the new queue\n2. update code');
    const run = await awaitingRun(t);
    const res = await t.svc.approve(run.id);
    expect(res.status).toBe('denied');
    expect(t.calls).toHaveLength(1);
  });

  it('stops approval when the budget ran out in the meantime', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    t.usage.state.ok = false;
    expect((await t.svc.approve(run.id)).status).toBe('over_budget');
    expect(t.calls).toHaveLength(1);
  });

  it('rejects a plan', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    const r = t.svc.reject(run.id);
    expect(r).toMatchObject({ status: 'failed', summary: 'Plan rejected by user' });
    expect(t.inbox.resolved).toContain(planKey(run.id));
    expect(t.audit.entries.find((e) => e.action === 'automation.reject')?.actor).toBe('user');
    expect(() => t.svc.reject(run.id)).toThrow(ServiceError);
  });

  it('reruns with the same vars', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    const again = await t.svc.rerun(run.id);
    expect(again).toMatchObject({ triggerSource: 'rerun', rerunOf: run.id, vars: { ticket: 'SAF-9' } });
    await t.svc.waitFor(again?.id ?? '');
  });
});
