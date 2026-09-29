import { ApiRequestError } from '@orc/api-contract';
import type { CheckpointRecord, PrStatus, ReviewSummary } from '@orc/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { CheckpointTimeline } from './CheckpointTimeline.tsx';
import { PresetButtons } from './PresetButtons.tsx';
import { ReviewAside } from './ReviewAside.tsx';
import { ShipPanel } from './ShipPanel.tsx';
import { SummaryCard } from './SummaryCard.tsx';

const summary = (p: Partial<ReviewSummary> = {}): ReviewSummary => ({
  sessionPk: 'claude:s1',
  cwd: '/w',
  worktree: {
    path: '/w',
    repo: '/r',
    branch: 'feat/SAF-1-x',
    base: 'main',
    ticket: 'SAF-1',
    dirty: true,
    prUrl: null,
    state: 'active',
    createdByApp: true,
    head: 'h',
    isMain: false,
    origin: 'app',
    sessionPks: ['claude:s1'],
    projectId: 'wakecap',
    prStatus: null,
    updatedAt: 'x',
  },
  files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
  additions: 3,
  deletions: 1,
  lastTest: { ts: 'x', command: 'pnpm test', passed: 10, failed: 2, skipped: 0, durationMs: 100 },
  recap: null,
  pr: null,
  owned: true,
  checkpoints: [],
  ...p,
});

const needConfirm = (summaryText: string) =>
  new ApiRequestError(409, 'confirmation_required', 'c', { summary: summaryText });

describe('SummaryCard', () => {
  it('shows files, tests, a missing recap and no PR', () => {
    renderWithProviders(<SummaryCard summary={summary()} />);
    expect(screen.getByText('1 file · +3 −1')).toBeDefined();
    expect(screen.getByText('Tests: 10 passed, 2 failed')).toBeDefined();
    expect(screen.getByText('No recap yet')).toBeDefined();
    expect(screen.getByText('No PR yet')).toBeDefined();
  });

  it('shows the PR once the ship panel has created it', async () => {
    const ref = { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' };
    const status: PrStatus = {
      pr: ref,
      state: 'open',
      title: 'SAF-1 x',
      checks: 'none',
      review: 'none',
      updatedAt: 'x',
      headRef: 'feat/SAF-1-x',
      failedChecks: [],
    };
    // Daemon behaviour: `POST /ship/pr` stores prUrl on the worktree; the PR status lands in the
    // pr cache only when `GET /github/pr` (or the poller) fetches it.
    let prUrl: string | null = null;
    let cached: PrStatus | null = null;
    const base = summary();
    const api = createFakeApi({
      reviewGet: async () => ({
        ...base,
        worktree: base.worktree ? { ...base.worktree, prUrl, prStatus: cached } : null,
        pr: cached,
      }),
      diffGet: async () => ({ cwd: '/w', from: 'b', to: 'WORKTREE', files: [], additions: 0, deletions: 0 }),
      checkpointsList: async () => [],
      shipSuggest: async () => ({
        message: 'feat: SAF-1 x',
        title: 'SAF-1 x',
        body: 'b',
        base: 'main',
        branch: 'feat/SAF-1-x',
        ticket: 'SAF-1',
      }),
      shipPr: vi.fn(async (b: { confirm: boolean }) => {
        if (!b.confirm) throw needConfirm('pr?');
        prUrl = ref.url;
        return ref;
      }) as unknown as FakeApi['shipPr'],
      githubPr: async () => {
        cached = status;
        return status;
      },
    });
    renderWithProviders(
      <ReviewAside source="claude" id="s1" selected={{ kind: 'worktree' }} select={() => {}} />,
      { api },
    );
    const card = await screen.findByRole('region', { name: 'Review summary' });
    expect(within(card).getByText('No PR yet')).toBeDefined();
    await waitFor(() =>
      expect((screen.getByLabelText('PR title') as HTMLInputElement).value).toBe('SAF-1 x'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create PR' }).at(-1) as HTMLElement);
    expect(await screen.findByText('#7 · open · checks none')).toBeDefined();
    await waitFor(() => expect(within(card).queryByText('No PR yet')).toBeNull());
    expect(within(card).getByText(/PR #7/)).toBeDefined();
  });
});

describe('CheckpointTimeline', () => {
  it('selects a turn and rewinds after confirmation', async () => {
    const cps: CheckpointRecord[] = [
      {
        id: 'c1',
        sessionId: 's1',
        worktreePath: '/w',
        turn: 1,
        ref: 'r1',
        commit: 'a',
        createdAt: '2026-09-17T10:00:00Z',
        kind: 'turn',
      },
      {
        id: 'c2',
        sessionId: 's1',
        worktreePath: '/w',
        turn: 2,
        ref: 'r2',
        commit: 'b',
        createdAt: '2026-09-17T10:05:00Z',
        kind: 'turn',
      },
    ];
    const rewind = vi.fn(async (_id: string, b: { confirm: boolean }) => {
      if (!b.confirm) throw needConfirm('Restore the files in /w to turn 1.');
      return { safety: { ...cps[1], id: 'c3', kind: 'safety' } };
    });
    const api = createFakeApi({
      checkpointsList: async () => cps,
      checkpointsRewind: rewind as unknown as FakeApi['checkpointsRewind'],
    });
    const onSelect = vi.fn();
    renderWithProviders(
      <CheckpointTimeline sessionPk="claude:s1" selected={{ kind: 'worktree' }} onSelect={onSelect} />,
      { api },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Turn 2' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'checkpoint', id: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to turn 1' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rewind files?' });
    expect(within(dialog).getByText('Restore the files in /w to turn 1.')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rewind).not.toHaveBeenCalledWith('c1', { confirm: true });
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to turn 1' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(rewind).toHaveBeenLastCalledWith('c1', { confirm: true }));
  });

  it('lists safety checkpoints alongside turn checkpoints', async () => {
    const cps: CheckpointRecord[] = [
      {
        id: 'c1',
        sessionId: 's1',
        worktreePath: '/w',
        turn: 1,
        ref: 'r1',
        commit: 'a',
        createdAt: '2026-09-17T10:00:00Z',
        kind: 'turn',
      },
      {
        id: 'c2',
        sessionId: 's1',
        worktreePath: '/w',
        turn: 2,
        ref: 'r2',
        commit: 'b',
        createdAt: '2026-09-17T10:05:00Z',
        kind: 'safety',
      },
    ];
    renderWithProviders(
      <CheckpointTimeline sessionPk="claude:s1" selected={{ kind: 'worktree' }} onSelect={() => {}} />,
      { api: createFakeApi({ checkpointsList: async () => cps }) },
    );
    await screen.findByRole('button', { name: 'Turn 1' });
    const items = within(screen.getByRole('region', { name: 'Checkpoints' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Rewind to turn 2' })).toBeDefined();
  });
});

describe('ShipPanel', () => {
  it('prefills from the suggestion and commits, pushes and opens a PR with confirmation', async () => {
    const calls: string[] = [];
    const confirmable = <T,>(name: string, result: T) =>
      vi.fn(async (b: { confirm: boolean }) => {
        if (!b.confirm) throw needConfirm(`${name}?`);
        calls.push(name);
        return result;
      });
    const shipPr = confirmable('pr', { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' });
    const api = createFakeApi({
      shipSuggest: async () => ({
        message: 'feat: SAF-1 x',
        title: 'SAF-1 x',
        body: '## Summary',
        base: 'main',
        branch: 'feat/SAF-1-x',
        ticket: 'SAF-1',
      }),
      shipCommit: confirmable('commit', { sha: 'abc' }) as unknown as FakeApi['shipCommit'],
      shipPush: confirmable('push', { ok: true }) as unknown as FakeApi['shipPush'],
      shipPr: shipPr as unknown as FakeApi['shipPr'],
      githubPr: async () => ({
        pr: { repo: 'o/r', number: 7, url: 'u' },
        state: 'open',
        title: 't',
        checks: 'pending',
        review: 'review_required',
        updatedAt: 'x',
        headRef: 'feat/SAF-1-x',
        failedChecks: [],
      }),
    });
    renderWithProviders(<ShipPanel summary={summary()} />, { api });
    expect(((await screen.findByLabelText('Commit message')) as HTMLTextAreaElement).value).toBe(
      'feat: SAF-1 x',
    );
    for (const [button, confirmLabel] of [
      ['Commit', 'Commit'],
      ['Push', 'Push'],
      ['Create PR', 'Create PR'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await screen.findByRole('alertdialog');
      fireEvent.click(screen.getAllByRole('button', { name: confirmLabel }).at(-1) as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    }
    expect(calls).toEqual(['commit', 'push', 'pr']);
    expect(shipPr).toHaveBeenLastCalledWith({
      cwd: '/w',
      title: 'SAF-1 x',
      body: '## Summary',
      base: 'main',
      draft: false,
      confirm: true,
    });
    expect(await screen.findByText('#7 · open · checks pending')).toBeDefined();
  });
});

describe('PresetButtons', () => {
  it('launches Fix CI with the failing check in the worktree', async () => {
    const launch = vi.fn(async () => ({ ptyId: 'pty-9', sessionId: null }));
    const api = createFakeApi({ sessionsLaunch: launch as unknown as FakeApi['sessionsLaunch'] });
    const pr = {
      pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
      state: 'open' as const,
      title: 't',
      checks: 'failure' as const,
      review: 'none' as const,
      updatedAt: 'x',
      headRef: 'h',
      failedChecks: ['unit'],
    };
    renderWithProviders(<PresetButtons summary={summary({ pr })} />, { api });
    expect(screen.queryByRole('button', { name: 'Address comments' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fix CI' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith({
        source: 'claude',
        projectId: 'wakecap',
        cwd: '/w',
        prompt: '',
        templateId: 'preset-fix-ci',
        vars: { prUrl: 'https://github.com/o/r/pull/7', check: 'unit', ticket: 'SAF-1' },
        planApproval: false,
      }),
    );
  });
});
