import type { CompareView } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 } from '@/test/p3-render.tsx';
import { ComparePage } from './ComparePage.tsx';

const variant = (index: number, source: 'claude' | 'codex') => ({
  index,
  source,
  model: null,
  label: `v${index + 1} ${source}`,
  sessionId: `s${index}`,
  sessionPk: `${source}:s${index}`,
  ptyId: null,
  worktreePath: `/w/${index + 1}`,
  branch: null,
  error: null,
  status: 'review',
  costUsd: null,
  durationMs: null,
  tests: null,
  recap: null,
  diff: null,
});

const decided: CompareView = {
  group: {
    id: 'g1',
    projectId: null,
    prompt: 'p',
    ticket: null,
    repo: '/r',
    base: 'main',
    createdAt: '2026-09-17T09:00:00.000Z',
    state: 'decided',
    winnerIndex: 0,
    estimateUsd: null,
    variants: [],
  },
  variants: [variant(0, 'claude'), variant(1, 'codex')],
};

afterEach(() => setApiClientForTests(null));

describe('ComparePage archive without a confirm prop', () => {
  it('asks in an in-app dialog listing the worktrees, and archives only on confirm', async () => {
    const compareArchiveLosers = vi.fn(async () => ({
      group: decided.group,
      results: [{ index: 1, worktreePath: '/w/2', killed: true, archived: true, reason: null }],
    }));
    setApiClientForTests(fakeApi({ compareGet: vi.fn(async () => decided), compareArchiveLosers }));
    renderP3(<ComparePage groupId="g1" navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive the other variants' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Archive the other variants' });
    expect(within(dialog).getByText('/w/2')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(compareArchiveLosers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive the other variants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop and archive' }));
    await waitFor(() => expect(compareArchiveLosers).toHaveBeenCalledWith('g1'));
    expect(await screen.findByText('v2: archived (session stopped)')).toBeTruthy();
  });
});
