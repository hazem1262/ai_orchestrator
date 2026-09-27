import type { Automation, AutomationRunDetail } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinearIssue } from '../../src/connectors/linear/linear.ts';
import { attachTriggerDispatcher } from '../../src/services/automations/dispatcher.ts';
import type { TriggerFire } from '../../src/services/automations/service.ts';
import { fakeProjects, testConfig } from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

describe('attachTriggerDispatcher', () => {
  let ctx: TestContext | null = null;
  afterEach(() => {
    ctx?.dispose();
    ctx = null;
  });

  it('starts matching enabled automations with the event key and vars', async () => {
    const cfg = testConfig();
    const p = cfg.projects[0];
    if (p) p.repos = [{ path: '/Users/test/Wakecap/Backend/svc', copyGlobs: [], worktreeDir: '.worktrees' }];
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const autos: Automation[] = [
      {
        id: 'fix',
        name: 'Fix CI',
        enabled: true,
        trigger: { type: 'github', event: 'check_failed' },
        action: {
          templateId: 't',
          projectId: 'wakecap',
          useWorktree: true,
          headless: true,
          timeoutMin: 5,
          planApproval: false,
        },
        budgetUsd: 5,
      },
      {
        id: 'off',
        name: 'Off',
        enabled: false,
        trigger: { type: 'github', event: 'check_failed' },
        action: {
          templateId: 't',
          projectId: 'wakecap',
          useWorktree: true,
          headless: true,
          timeoutMin: 5,
          planApproval: false,
        },
        budgetUsd: 5,
      },
    ];
    const starts: Array<[string, TriggerFire]> = [];
    const detach = attachTriggerDispatcher(ctx, {
      list: () => autos,
      start: async (id, fire) => {
        starts.push([id, fire]);
        return null as AutomationRunDetail | null;
      },
    });
    const before: PrStatus = {
      pr: { repo: 'example-org/svc', number: 3, url: 'https://github.com/example-org/svc/pull/3' },
      state: 'open',
      title: 'chore',
      checks: 'pending',
      review: 'none',
      updatedAt: 't1',
      headRef: null,
      failedChecks: [],
    };
    ctx.bus.emit({
      type: 'pr.changed',
      before,
      after: { ...before, checks: 'failure', updatedAt: 't2', failedChecks: ['ci'] },
    });
    expect(starts).toEqual([
      [
        'fix',
        {
          key: 'github:example-org/svc#3:check_failed:t2',
          source: 'github',
          vars: { prUrl: 'https://github.com/example-org/svc/pull/3', check: 'ci' },
        },
      ],
    ]);
    detach();
    ctx.bus.emit({ type: 'pr.changed', before, after: { ...before, checks: 'failure', updatedAt: 't3' } });
    expect(starts).toHaveLength(1);
  });

  const automation = (id: string, trigger: Automation['trigger']): Automation => ({
    id,
    name: id,
    enabled: true,
    trigger,
    action: {
      templateId: 't',
      projectId: 'wakecap',
      useWorktree: true,
      headless: true,
      timeoutMin: 5,
      planApproval: false,
    },
    budgetUsd: 5,
  });

  function recordStarts(c: TestContext, autos: Automation[]) {
    const starts: Array<[string, TriggerFire]> = [];
    const detach = attachTriggerDispatcher(c, {
      list: () => autos,
      start: async (id, fire) => {
        starts.push([id, fire]);
        return null;
      },
    });
    return { starts, detach };
  }

  it('starts automations matching a linear.issueChanged event and skips the rest', () => {
    const cfg = testConfig();
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const { starts, detach } = recordStarts(ctx, [
      automation('assigned', { type: 'linear', event: 'assigned' }),
      automation('agent-ok', { type: 'linear', event: 'labeled', label: 'Agent-OK' }),
      automation('other-label', { type: 'linear', event: 'labeled', label: 'other' }),
      automation('slack', { type: 'slack', event: 'mention', channel: 'C1' }),
    ]);
    const issue = (identifier: string, labels: string[] = []): LinearIssue => ({
      id: identifier,
      identifier,
      title: 't',
      state: 'Todo',
      assignee: 'me',
      url: `https://linear.app/x/issue/${identifier}`,
      labels,
    });
    ctx.bus.emit({ type: 'linear.issueChanged', before: null, after: issue('SAF-2') });
    ctx.bus.emit({
      type: 'linear.issueChanged',
      before: issue('SAF-1'),
      after: issue('SAF-1', ['agent-ok']),
    });
    ctx.bus.emit({ type: 'linear.issueChanged', before: null, after: issue('ENG-1') });
    expect(starts).toEqual([
      [
        'assigned',
        {
          key: 'linear:SAF-2:assigned',
          source: 'linear',
          vars: { ticket: 'SAF-2', ticketUrl: 'https://linear.app/x/issue/SAF-2' },
        },
      ],
      [
        'agent-ok',
        {
          key: 'linear:SAF-1:label:agent-ok',
          source: 'linear',
          vars: { ticket: 'SAF-1', ticketUrl: 'https://linear.app/x/issue/SAF-1', label: 'agent-ok' },
        },
      ],
    ]);
    detach();
    ctx.bus.emit({ type: 'linear.issueChanged', before: null, after: issue('SAF-3') });
    expect(starts).toHaveLength(2);
  });

  it('starts automations matching a slack.mention event by channel', () => {
    const cfg = testConfig();
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const { starts, detach } = recordStarts(ctx, [
      automation('c1', { type: 'slack', event: 'mention', channel: 'C1' }),
      automation('c2', { type: 'slack', event: 'mention', channel: 'C2' }),
      automation('linear', { type: 'linear', event: 'assigned' }),
    ]);
    ctx.bus.emit({
      type: 'slack.mention',
      channel: 'C1',
      ts: '1788253300.000001',
      text: 'please check SAF-9',
    });
    expect(starts).toEqual([
      [
        'c1',
        {
          key: 'slack:C1:1788253300.000001',
          source: 'slack',
          vars: { slackText: 'please check SAF-9', ticket: 'SAF-9' },
        },
      ],
    ]);
    detach();
    ctx.bus.emit({ type: 'slack.mention', channel: 'C1', ts: '1788253400.000002', text: 'again' });
    expect(starts).toHaveLength(1);
  });
});
