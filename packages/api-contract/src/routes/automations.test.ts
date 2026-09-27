import { describe, expect, it } from 'vitest';
import { Automation, AutomationInput, AutomationRunDetail } from './automations.ts';

const base = {
  name: 'Fix CI on my PRs',
  enabled: false,
  trigger: { type: 'github', event: 'check_failed' },
  action: {
    templateId: 'fix-ci',
    projectId: 'wakecap',
    useWorktree: true,
    headless: true,
    timeoutMin: 30,
    planApproval: false,
  },
  budgetUsd: 10,
};

describe('Automation schema', () => {
  it('accepts every trigger type', () => {
    for (const trigger of [
      { type: 'cron', cron: '0 9 * * 1-5' },
      { type: 'github', event: 'review_comment' },
      { type: 'linear', event: 'labeled', label: 'agent-ok' },
      { type: 'slack', event: 'mention', channel: 'C123' },
      { type: 'manual' },
    ]) {
      expect(Automation.safeParse({ ...base, id: 'a1', trigger }).success).toBe(true);
    }
  });

  it('rejects unknown events, bad budgets and long timeouts', () => {
    expect(
      Automation.safeParse({ ...base, id: 'a1', trigger: { type: 'github', event: 'pr_opened' } }).success,
    ).toBe(false);
    expect(Automation.safeParse({ ...base, id: 'a1', budgetUsd: 0 }).success).toBe(false);
    expect(
      Automation.safeParse({ ...base, id: 'a1', action: { ...base.action, timeoutMin: 600 } }).success,
    ).toBe(false);
  });

  it('lets the input omit the id', () => {
    expect(AutomationInput.parse(base).id).toBeUndefined();
  });

  it('parses a run detail with the awaiting_approval status', () => {
    const run = AutomationRunDetail.parse({
      id: 'r1',
      automationId: 'a1',
      startedAt: '2026-09-17T09:00:00.000Z',
      endedAt: null,
      status: 'awaiting_approval',
      sessionPk: 'claude:s1',
      costUsd: 0.4,
      summary: 'plan',
      triggerKey: 'manual:x',
      triggerSource: 'manual',
      vars: {},
      ptyId: null,
      worktreePath: null,
      prUrl: null,
      diffStat: null,
      error: null,
      rerunOf: null,
    });
    expect(run.status).toBe('awaiting_approval');
  });
});
