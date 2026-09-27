import type { CompareGroup, CompareVariantInput, CompareView } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 as renderWithClient } from '@/test/p3-render.tsx';
import { CompareLaunchSection } from './CompareLaunchSection.tsx';
import { ComparePage } from './ComparePage.tsx';

const group: CompareGroup = {
  id: 'g1',
  projectId: 'wakecap',
  prompt: 'Skip weekends in SLA',
  ticket: 'SAF-1787',
  repo: '/r',
  base: 'main',
  createdAt: '2026-09-17T09:00:00.000Z',
  state: 'running',
  winnerIndex: null,
  estimateUsd: 3,
  variants: [],
};

const data: CompareView = {
  group,
  variants: [
    {
      index: 0,
      source: 'claude',
      model: 'claude-opus-5',
      label: 'v1 claude:claude-opus-5',
      sessionId: 'a',
      sessionPk: 'claude:a',
      ptyId: 'pty-1',
      worktreePath: '/w/1',
      branch: 'feat/SAF-1787-sla-v1',
      error: null,
      status: 'review',
      costUsd: 2.1,
      durationMs: 600_000,
      tests: { ts: 't', command: 'pnpm test', passed: 20, failed: 0, skipped: 0, durationMs: 1000 },
      recap: 'Added isWeekend helper',
      diff: { files: 2, insertions: 30, deletions: 4, untracked: 0 },
    },
    {
      index: 1,
      source: 'codex',
      model: null,
      label: 'v2 codex',
      sessionId: null,
      sessionPk: null,
      ptyId: 'pty-2',
      worktreePath: '/w/2',
      branch: 'feat/SAF-1787-sla-v2',
      error: null,
      status: 'starting',
      costUsd: null,
      durationMs: null,
      tests: null,
      recap: null,
      diff: { files: 5, insertions: 90, deletions: 20, untracked: 1 },
    },
  ],
};

afterEach(() => setApiClientForTests(null));

describe('ComparePage', () => {
  it('shows variants side by side and opens review for the winner', async () => {
    const stubs = {
      compareGet: vi.fn(async () => data),
      comparePickWinner: vi.fn(async () => ({
        group: { ...group, state: 'decided' as const, winnerIndex: 0 },
        reviewUrl: '/review/claude/a',
      })),
      compareArchiveLosers: vi.fn(),
    };
    setApiClientForTests(fakeApi(stubs));
    const navigate = vi.fn();
    renderWithClient(<ComparePage groupId="g1" navigate={navigate} confirm={() => true} />);
    expect(await screen.findByText('v1 claude:claude-opus-5')).toBeTruthy();
    expect(screen.getByText('v2 codex')).toBeTruthy();
    expect(screen.getByText('20 passed · 0 failed')).toBeTruthy();
    expect(screen.getByText('+30 −4 in 2 files')).toBeTruthy();
    expect(screen.getByText('Added isWeekend helper')).toBeTruthy();
    expect(screen.getByText('Cheapest')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pick v2 codex' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pick v1 claude:claude-opus-5' }));
    await waitFor(() => expect(stubs.comparePickWinner).toHaveBeenCalledWith('g1', 0));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/review/claude/a'));
  });

  it('archives the other variants only after confirmation', async () => {
    const decided: CompareView = { ...data, group: { ...group, state: 'decided', winnerIndex: 0 } };
    const stubs = {
      compareGet: vi.fn(async () => decided),
      compareArchiveLosers: vi.fn(async () => ({
        group: decided.group,
        results: [
          {
            index: 1,
            worktreePath: '/w/2',
            killed: true,
            archived: false,
            reason: 'worktree has uncommitted changes',
          },
        ],
      })),
    };
    setApiClientForTests(fakeApi(stubs));
    const confirm = vi.fn(() => false);
    renderWithClient(<ComparePage groupId="g1" navigate={vi.fn()} confirm={confirm} />);
    const button = await screen.findByRole('button', { name: 'Archive the other variants' });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/w/2'));
    expect(stubs.compareArchiveLosers).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    expect(await screen.findByText(/v2: kept — worktree has uncommitted changes/)).toBeTruthy();
  });
});

function Harness({ onChange }: { onChange(v: CompareVariantInput[]): void }) {
  const [value, setValue] = useState<CompareVariantInput[]>([]);
  return (
    <CompareLaunchSection
      projectId="wakecap"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('CompareLaunchSection', () => {
  it('adds variants and shows the cost multiplier before launch', async () => {
    const stubs = {
      compareEstimate: vi.fn(async (_p: string | null, n: number) => ({
        variants: n,
        multiplier: n,
        avgSessionCostUsd: 2,
        estimatedUsd: 2 * n,
        sample: 5,
        burnRateUsdPerHour: 1,
        budget: { ok: true, pct: 0.9, limitUsd: 20 },
      })),
    };
    setApiClientForTests(fakeApi(stubs));
    const changes = vi.fn();
    renderWithClient(<Harness onChange={changes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Opus' }));
    expect(screen.queryByText(/Runs \d agents/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Codex' }));
    expect(changes).toHaveBeenLastCalledWith([
      { source: 'claude', model: 'claude-opus-5' },
      { source: 'codex' },
    ]);
    expect(await screen.findByText(/Runs 2 agents · 2× the cost/)).toBeTruthy();
    expect(screen.getByText('Budget at 90% of $20.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove v1' }));
    expect(changes).toHaveBeenLastCalledWith([{ source: 'codex' }]);
  });
});
