import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DISALLOWED_TOOLS,
  AUTOMATION_PREAMBLE,
  automationClaudeArgs,
  buildAutomationPrompt,
  checkAutomationGuards,
} from '../../src/services/automations/guardrails.ts';
import { fakeDenyList, fakeUsage } from '../fakes/phase7.ts';

const input = (over: Partial<Parameters<typeof checkAutomationGuards>[0]> = {}) => ({
  masterEnabled: true,
  renderedPrompt: 'Fix the failing check on https://github.com/example-org/svc/pull/12',
  projectId: 'wakecap',
  denyList: fakeDenyList(),
  usage: fakeUsage(),
  monthSpendUsd: 2,
  budgetUsd: 10,
  ...over,
});

describe('checkAutomationGuards', () => {
  it('passes a benign prompt and reports the remaining budget', () => {
    expect(checkAutomationGuards(input())).toEqual({ ok: true, remainingUsd: 8 });
  });

  it('denies everything while the master switch is off', () => {
    expect(checkAutomationGuards(input({ masterEnabled: false }))).toMatchObject({
      ok: false,
      status: 'denied',
    });
  });

  it.each([
    'then run terraform apply in infra',
    'merge the PR once checks are green',
    'gh pr merge 12 --squash',
    'deploy the service to production',
    'git push --force origin feat/x',
  ])('denies "%s"', (renderedPrompt) => {
    expect(checkAutomationGuards(input({ renderedPrompt }))).toMatchObject({ ok: false, status: 'denied' });
  });

  it('stops when the project budget is exhausted', () => {
    expect(checkAutomationGuards(input({ usage: fakeUsage({ ok: false }) }))).toMatchObject({
      ok: false,
      status: 'over_budget',
    });
  });

  it('stops when the automation budget is used up this month', () => {
    expect(checkAutomationGuards(input({ monthSpendUsd: 10 }))).toMatchObject({
      ok: false,
      status: 'over_budget',
    });
  });

  it('checks only the rendered template, not the preamble that itself mentions merge and production', () => {
    expect(AUTOMATION_PREAMBLE).toMatch(/merge/i);
    const full = buildAutomationPrompt('Update the README');
    expect(full.startsWith(AUTOMATION_PREAMBLE)).toBe(true);
    expect(full.endsWith('Update the README')).toBe(true);
    expect(checkAutomationGuards(input({ renderedPrompt: 'Update the README' })).ok).toBe(true);
  });
});

describe('automationClaudeArgs', () => {
  it('never allows merge, force-push, deploy or prod tools', () => {
    const args = automationClaudeArgs({ permissionMode: 'acceptEdits' });
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(args).not.toContain('--dangerously-skip-permissions');
    for (const t of [
      'Bash(gh pr merge *)',
      'Bash(git merge *)',
      'Bash(git push --force *)',
      'Bash(kubectl *)',
      'Bash(terraform *)',
    ]) {
      expect(AUTOMATION_DISALLOWED_TOOLS).toContain(t);
      expect(args).toContain(t);
    }
    expect(args.indexOf('--disallowed-tools')).toBeGreaterThan(args.indexOf('--allowed-tools'));
  });
});
