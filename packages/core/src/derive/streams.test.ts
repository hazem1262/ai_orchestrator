import { describe, expect, it } from 'vitest';
import type { StreamPr } from '../types/index.ts';
import {
  applyManualLinks,
  collectTicketSignals,
  computeStreamStage,
  extractTicketsFrom,
  groupSignals,
  isBackmergePr,
  parseWstackEnv,
  planTicket,
  type StreamSessionInput,
} from './streams.ts';

const pr = (n: number, p: Partial<StreamPr> = {}): StreamPr => ({
  pr: { repo: 'example-org/svc', number: n, url: `https://github.com/example-org/svc/pull/${n}` },
  title: `PR ${n}`,
  state: 'open',
  headRef: null,
  baseRef: null,
  isBackmerge: false,
  checks: 'none',
  review: 'none',
  updatedAt: '2026-09-10T10:00:00.000Z',
  mergedAt: null,
  ...p,
});
const sess = (pk: string, p: Partial<StreamSessionInput> = {}): StreamSessionInput => ({
  pk,
  projectId: 'wakecap',
  name: null,
  firstPrompt: null,
  lastPrompt: null,
  tickets: [],
  prs: [],
  skills: [],
  costUsd: 1,
  startedAt: '2026-09-10T09:00:00.000Z',
  lastActivityAt: '2026-09-10T10:00:00.000Z',
  liveStatus: null,
  recap: null,
  ...p,
});

describe('ticket helpers', () => {
  it('extracts unique upper-cased tickets', () => {
    expect(extractTicketsFrom('fix saf-1787 and SAF-1787, then ALU-2; not FOO-1', null)).toEqual([
      'SAF-1787',
      'ALU-2',
    ]);
    expect(extractTicketsFrom('X-9 here', '\\bX-\\d+\\b')).toEqual(['X-9']);
    expect(extractTicketsFrom('bad', '(')).toEqual([]);
    expect(extractTicketsFrom(null, null)).toEqual([]);
  });

  it('detects backmerge PRs', () => {
    expect(
      isBackmergePr({
        title: 'chore: sync',
        headRef: 'backmerge/SAF-1-master-to-staging',
        baseRef: 'staging',
      }),
    ).toBe(true);
    expect(isBackmergePr({ title: 'Back-merge master into staging', headRef: 'x', baseRef: null })).toBe(
      true,
    );
    expect(isBackmergePr({ title: 'sync', headRef: 'master', baseRef: 'staging' })).toBe(true);
    expect(isBackmergePr({ title: 'feat: SAF-1', headRef: 'feat/SAF-1-x', baseRef: 'master' })).toBe(false);
  });

  it('reads plan tickets from the file name only', () => {
    expect(planTicket('/w/plans/sla/SAF-1787-exclude-weekends.md', null)).toBe('SAF-1787');
    expect(planTicket('/w/plans/notes-SAF-1787.md', null)).toBeNull();
  });

  it('parses wstack env files', () => {
    expect(
      parseWstackEnv('# c\nWORKFLOW_ID=wf-1\nexport BRANCH="feat/SAF-9-x"\nREPO_SLUG=\'svc\'\nbad line\n'),
    ).toEqual({
      WORKFLOW_ID: 'wf-1',
      BRANCH: 'feat/SAF-9-x',
      REPO_SLUG: 'svc',
    });
  });
});

describe('collectTicketSignals', () => {
  const input = {
    sessions: [
      sess('claude:a', { tickets: ['SAF-1'], firstPrompt: 'also look at ALU-7' }),
      sess('claude:b', { prs: [pr(5).pr] }),
    ],
    prs: [
      pr(5, { title: 'feat(svc): SAF-1 weekends', headRef: 'feat/SAF-1-weekends' }),
      pr(6, { title: 'x', headRef: 'backmerge/SAF-1-staging' }),
    ],
    plans: [{ path: '/w/plans/SAF-2-plan.md', mtime: '2026-09-01T00:00:00.000Z' }],
    workflows: [
      {
        file: '/h/.wstack/workflows/wf.env',
        env: { BRANCH: 'fix/SAF-3-y' },
        mtime: '2026-09-02T00:00:00.000Z',
      },
    ],
    worktrees: [
      { path: '/w/svc/.worktrees/feat-SAF-4', branch: 'feat/SAF-4-z', ticket: null, updatedAt: null },
    ],
  };

  it('collects signals from every source', () => {
    const got = collectTicketSignals(input, null).map((s) => `${s.ticket}|${s.kind}|${s.ref}|${s.source}`);
    expect(got).toEqual([
      'SAF-1|session|claude:a|session_tickets',
      'ALU-7|session|claude:a|prompt',
      'SAF-1|session|claude:b|pr_title',
      'SAF-1|pr|https://github.com/example-org/svc/pull/5|pr_title',
      'SAF-1|pr|https://github.com/example-org/svc/pull/6|branch',
      'SAF-2|plan|/w/plans/SAF-2-plan.md|plan_file',
      'SAF-3|workflow|/h/.wstack/workflows/wf.env|wstack_workflow',
      'SAF-4|worktree|/w/svc/.worktrees/feat-SAF-4|worktree',
    ]);
  });

  it('applies manual unlinks and links, then groups', () => {
    const signals = applyManualLinks(collectTicketSignals(input, null), [
      { ticket: 'ALU-7', kind: 'session', ref: 'claude:a', origin: 'manual', excluded: true, createdAt: 'x' },
      {
        ticket: 'SAF-2',
        kind: 'session',
        ref: 'claude:z',
        origin: 'manual',
        excluded: false,
        createdAt: 'x',
      },
    ]);
    const groups = groupSignals(signals);
    expect(groups.map((g) => g.ticket)).toEqual(['SAF-1', 'SAF-2', 'SAF-3', 'SAF-4']);
    expect(groups[0]?.refs.session).toEqual(['claude:a', 'claude:b']);
    expect(groups[0]?.refs.pr).toHaveLength(2);
    expect(groups[1]?.refs).toMatchObject({ plan: ['/w/plans/SAF-2-plan.md'], session: ['claude:z'] });
  });
});

describe('computeStreamStage', () => {
  const base = {
    prs: [] as StreamPr[],
    sessions: [] as Array<{ skills: string[]; liveStatus: null | 'review' | 'busy' }>,
    hasWorktrees: false,
  };
  it('walks the stages in priority order', () => {
    expect(computeStreamStage(base)).toBe('planned');
    expect(computeStreamStage({ ...base, hasWorktrees: true })).toBe('implementing');
    expect(computeStreamStage({ ...base, sessions: [{ skills: ['conductor'], liveStatus: 'busy' }] })).toBe(
      'implementing',
    );
    expect(computeStreamStage({ ...base, sessions: [{ skills: ['review'], liveStatus: null }] })).toBe(
      'in_review',
    );
    expect(computeStreamStage({ ...base, sessions: [{ skills: [], liveStatus: 'review' }] })).toBe(
      'in_review',
    );
    expect(computeStreamStage({ ...base, prs: [pr(1)] })).toBe('pr_open');
    expect(
      computeStreamStage({ ...base, prs: [pr(1, { state: 'merged' }), pr(2, { isBackmerge: true })] }),
    ).toBe('merged');
    expect(
      computeStreamStage({
        ...base,
        prs: [pr(1, { state: 'merged' }), pr(2, { isBackmerge: true, state: 'merged' })],
      }),
    ).toBe('backmerged');
    expect(
      computeStreamStage({ ...base, prs: [pr(1)], sessions: [{ skills: ['releaseit'], liveStatus: null }] }),
    ).toBe('released');
    expect(computeStreamStage({ ...base, prs: [pr(1, { state: 'closed' })] })).toBe('planned');
  });
});
