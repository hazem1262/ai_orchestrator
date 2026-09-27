import type { Automation } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { describe, expect, it } from 'vitest';
import type { LinearIssue } from '../../src/connectors/linear/linear.ts';
import {
  githubEventsFromPrChange,
  linearEventsFromIssueChange,
  matchesTrigger,
  repoBelongsToProject,
  slackEventFromMention,
} from '../../src/services/automations/triggers.ts';
import { testConfig } from '../fakes/phase7.ts';

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  pr: {
    repo: 'example-org/wecare-service',
    number: 12,
    url: 'https://github.com/example-org/wecare-service/pull/12',
  },
  state: 'open',
  title: 'SAF-7 exclude weekends',
  checks: 'pending',
  review: 'review_required',
  updatedAt: '2026-09-17T09:00:00.000Z',
  headRef: 'feat/SAF-7-weekends',
  failedChecks: [],
  ...over,
});

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'i1',
  identifier: 'SAF-8',
  title: 'Add retries',
  state: 'Todo',
  assignee: 'me',
  url: 'https://linear.app/x/issue/SAF-8',
  labels: [],
  ...over,
});

const auto = (trigger: Automation['trigger'], over: Partial<Automation> = {}): Automation => ({
  id: 'a',
  name: 'n',
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
  ...over,
});

function project() {
  const cfg = testConfig();
  const p = cfg.projects[0];
  if (!p) throw new Error('no project');
  p.repos = [
    { path: '/Users/test/Wakecap/Backend/wecare-service', copyGlobs: [], worktreeDir: '.worktrees' },
  ];
  return p;
}

describe('githubEventsFromPrChange', () => {
  it('fires on transitions only', () => {
    expect(githubEventsFromPrChange(null, pr({ checks: 'failure' }))).toEqual([]);
    const failed = githubEventsFromPrChange(
      pr(),
      pr({ checks: 'failure', failedChecks: ['lint', 'test'], updatedAt: 't2' }),
    );
    expect(failed).toEqual([
      {
        type: 'github',
        event: 'check_failed',
        repo: 'example-org/wecare-service',
        key: 'github:example-org/wecare-service#12:check_failed:t2',
        vars: {
          prUrl: 'https://github.com/example-org/wecare-service/pull/12',
          ticket: 'SAF-7',
          check: 'lint, test',
        },
      },
    ]);
    expect(githubEventsFromPrChange(pr({ checks: 'failure' }), pr({ checks: 'failure' }))).toEqual([]);
    expect(
      githubEventsFromPrChange(pr(), pr({ review: 'changes_requested', updatedAt: 't3' })).map((e) => e.key),
    ).toEqual(['github:example-org/wecare-service#12:review_comment:t3']);
    expect(githubEventsFromPrChange(pr(), pr({ state: 'merged' })).map((e) => e.event)).toEqual([
      'pr_merged',
    ]);
    expect(
      githubEventsFromPrChange(pr({ state: 'closed' }), pr({ state: 'closed', checks: 'failure' })),
    ).toEqual([]);
  });
});

describe('linearEventsFromIssueChange', () => {
  it('fires assigned for new issues and labeled for each added label', () => {
    expect(linearEventsFromIssueChange(null, issue()).map((e) => e.key)).toEqual(['linear:SAF-8:assigned']);
    const labeled = linearEventsFromIssueChange(
      issue({ labels: ['bug'] }),
      issue({ labels: ['bug', 'Agent-OK'] }),
    );
    expect(labeled).toEqual([
      {
        type: 'linear',
        event: 'labeled',
        label: 'Agent-OK',
        key: 'linear:SAF-8:label:Agent-OK',
        vars: { ticket: 'SAF-8', ticketUrl: 'https://linear.app/x/issue/SAF-8', label: 'Agent-OK' },
      },
    ]);
    expect(linearEventsFromIssueChange(issue(), issue({ state: 'In Progress' }))).toEqual([]);
  });
});

describe('slackEventFromMention', () => {
  it('redacts and extracts the ticket', () => {
    const e = slackEventFromMention(
      { channel: 'C1', ts: '1788253200.000100', text: 'can you look at SAF-9? token=abc' },
      /\bSAF-\d+\b/g,
    );
    expect(e).toEqual({
      type: 'slack',
      event: 'mention',
      channel: 'C1',
      key: 'slack:C1:1788253200.000100',
      vars: { slackText: 'can you look at SAF-9? token=«redacted:secret»', ticket: 'SAF-9' },
    });
  });
});

describe('matchesTrigger', () => {
  const p = project();
  it('matches GitHub events for repos of the automation project', () => {
    const [e] = githubEventsFromPrChange(pr(), pr({ checks: 'failure' }));
    if (!e) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'github', event: 'check_failed' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'github', event: 'pr_merged' }), e, p)).toBe(false);
    expect(matchesTrigger(auto({ type: 'github', event: 'check_failed' }, { enabled: false }), e, p)).toBe(
      false,
    );
    expect(repoBelongsToProject('example-org/other-repo', p)).toBe(false);
    expect(repoBelongsToProject('example-org/wecare-service', null)).toBe(false);
  });

  it('matches Linear labels case-insensitively and checks the ticket prefix', () => {
    const [e] = linearEventsFromIssueChange(issue(), issue({ labels: ['agent-ok'] }));
    if (!e) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'linear', event: 'labeled', label: 'Agent-OK' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'linear', event: 'labeled', label: 'other' }), e, p)).toBe(false);
    const [foreign] = linearEventsFromIssueChange(null, issue({ identifier: 'ENG-1' }));
    if (!foreign) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'linear', event: 'assigned' }), foreign, p)).toBe(false);
  });

  it('matches Slack mentions by channel', () => {
    const e = slackEventFromMention({ channel: 'C1', ts: '1', text: 'hi' }, null);
    expect(matchesTrigger(auto({ type: 'slack', event: 'mention', channel: 'C1' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'slack', event: 'mention', channel: 'C2' }), e, p)).toBe(false);
    expect(matchesTrigger(auto({ type: 'manual' }), e, p)).toBe(false);
  });
});
