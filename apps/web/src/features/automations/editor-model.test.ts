import type { Automation } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import {
  buildAutomation,
  describeTrigger,
  emptyForm,
  formatSuccessRate,
  formFromAutomation,
} from './editor-model.ts';

describe('editor model', () => {
  it('builds each trigger type', () => {
    const base = { ...emptyForm('wakecap'), name: 'Nightly', templateId: 'fix-ci' };
    const cases: Array<[Partial<typeof base>, Automation['trigger']]> = [
      [
        { triggerType: 'cron', cron: ' 0 2 * * * ' },
        { type: 'cron', cron: '0 2 * * *' },
      ],
      [
        { triggerType: 'github', githubEvent: 'pr_merged' },
        { type: 'github', event: 'pr_merged' },
      ],
      [
        { triggerType: 'linear', linearEvent: 'labeled', linearLabel: 'agent-ok' },
        { type: 'linear', event: 'labeled', label: 'agent-ok' },
      ],
      [
        { triggerType: 'linear', linearEvent: 'assigned', linearLabel: 'ignored' },
        { type: 'linear', event: 'assigned' },
      ],
      [
        { triggerType: 'slack', slackChannel: ' C42 ' },
        { type: 'slack', event: 'mention', channel: 'C42' },
      ],
      [{ triggerType: 'manual' }, { type: 'manual' }],
    ];
    for (const [patch, trigger] of cases) {
      const r = buildAutomation({ ...base, ...patch });
      expect(r.ok && r.value.trigger).toEqual(trigger);
    }
  });

  it('reports validation errors', () => {
    const r = buildAutomation({ ...emptyForm('wakecap'), name: '', templateId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/name/);
  });

  it('round-trips an automation and drops empty optionals', () => {
    const a: Automation = {
      id: 'a1',
      name: 'Fix CI',
      enabled: true,
      trigger: { type: 'slack', event: 'mention', channel: 'C1' },
      action: {
        templateId: 'fix-ci',
        projectId: 'wakecap',
        useWorktree: false,
        headless: false,
        timeoutMin: 12,
        planApproval: true,
        model: 'claude-sonnet-5',
      },
      budgetUsd: 4,
    };
    const r = buildAutomation(formFromAutomation(a));
    expect(r.ok && r.value).toEqual(a);
    const noModel = buildAutomation({ ...formFromAutomation(a), model: '  ', repo: '' });
    expect(noModel.ok && noModel.value.action).not.toHaveProperty('model');
    expect(noModel.ok && noModel.value.action).not.toHaveProperty('repo');
  });

  it('describes triggers and success rates', () => {
    expect(describeTrigger({ type: 'github', event: 'check_failed' })).toBe('GitHub: check failed');
    expect(describeTrigger({ type: 'linear', event: 'labeled', label: 'x' })).toBe('Linear: label x');
    expect(describeTrigger({ type: 'cron', cron: '0 9 * * 1' })).toBe('Schedule 0 9 * * 1');
    expect(formatSuccessRate(null)).toBe('—');
    expect(formatSuccessRate(2 / 3)).toBe('67%');
  });
});
