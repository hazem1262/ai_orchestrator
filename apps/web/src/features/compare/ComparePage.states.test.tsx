import { ApiRequestError, type CompareGroup, type CompareView } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 } from '@/test/p3-render.tsx';
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
  estimateUsd: null,
  variants: [],
};

const data: CompareView = {
  group,
  variants: [
    {
      index: 0,
      source: 'claude',
      model: null,
      label: 'v1 claude',
      sessionId: 's0',
      sessionPk: 'claude:s0',
      ptyId: null,
      worktreePath: '/w/1',
      branch: null,
      error: null,
      status: 'review',
      costUsd: 1,
      durationMs: 1000,
      tests: null,
      recap: null,
      diff: null,
    },
  ],
};

afterEach(() => setApiClientForTests(null));

describe('ComparePage states', () => {
  it('shows an Empty state with a link back to Live when the group is missing', async () => {
    setApiClientForTests(
      fakeApi({
        compareGet: vi.fn(async () => {
          throw new ApiRequestError(404, 'not_found', 'compare group ghost not found');
        }),
      }),
    );
    renderP3(<ComparePage groupId="ghost" navigate={vi.fn()} />);
    expect(await screen.findByText('Comparison not found')).toBeTruthy();
    expect(screen.getByText(/ghost/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Go to Live' });
    expect(link.getAttribute('href')).toBe('/live');
  });

  it('shows an Alert with a retry action for a load error other than not-found', async () => {
    const compareGet = vi.fn(async () => {
      throw new ApiRequestError(500, 'internal', 'daemon exploded');
    });
    setApiClientForTests(fakeApi({ compareGet }));
    renderP3(<ComparePage groupId="g1" navigate={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load this comparison')).toBeTruthy();
    expect(within(alert).getByText('daemon exploded')).toBeTruthy();
    expect(compareGet).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(compareGet).toHaveBeenCalledTimes(2));
  });

  it('cancels a pick without calling the API', async () => {
    const comparePickWinner = vi.fn();
    setApiClientForTests(fakeApi({ compareGet: vi.fn(async () => data), comparePickWinner }));
    renderP3(<ComparePage groupId="g1" navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick v1 claude' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Pick v1 as the winner?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(comparePickWinner).not.toHaveBeenCalled();
  });
});
