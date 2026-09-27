import type { WorkStream } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { StreamsPage } from './StreamsPage.tsx';

const streams: WorkStream[] = [
  {
    ticket: 'SAF-1787',
    projectId: 'wakecap',
    title: 'Exclude weekends from the SLA deadline',
    stage: 'merged',
    sessionIds: ['claude:s1', 'claude:s2'],
    prs: [{ repo: 'o/r', number: 231, url: 'https://x/231' }],
    plans: ['/w/plans/SAF-1787-x.md'],
    worktrees: [],
    costUsd: 12.5,
    lastActivityAt: '2026-09-17T10:00:00.000Z',
  },
  {
    ticket: 'ALU-42',
    projectId: 'wakecap',
    title: null,
    stage: 'planned',
    sessionIds: [],
    prs: [],
    plans: [],
    worktrees: [],
    costUsd: 0,
    lastActivityAt: '2026-09-16T10:00:00.000Z',
  },
];

describe('StreamsPage', () => {
  it('lists streams with stage, cost and counts, and filters by stage', async () => {
    const streamsList = vi.fn(async () => streams);
    setApiClientForTests(fakeApi({ streamsList, streamsRefresh: vi.fn(async () => streams) }));
    const user = userEvent.setup();
    renderP3(<StreamsPage />);
    expect(await screen.findByRole('link', { name: /SAF-1787/ })).toHaveAttribute(
      'href',
      '/streams/SAF-1787',
    );
    expect(screen.getByText('Exclude weekends from the SLA deadline')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('2 sessions · 1 PR · 1 plan')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Stage'), 'merged');
    await waitFor(() =>
      expect(streamsList).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'merged' })),
    );
  });

  it('switches to the kanban board and back, and remembers the choice', async () => {
    setApiClientForTests(
      fakeApi({ streamsList: vi.fn(async () => streams), streamsRefresh: vi.fn(async () => streams) }),
    );
    const user = userEvent.setup();
    const first = renderP3(<StreamsPage />);
    await user.click(await screen.findByRole('button', { name: 'Kanban' }));
    expect(await screen.findByRole('region', { name: 'Merged' })).toBeTruthy();
    expect(window.localStorage.getItem('orc.stream-view')).toBe('kanban');
    first.unmount();
    renderP3(<StreamsPage />);
    expect(await screen.findByRole('region', { name: 'Planned' })).toBeTruthy();
  });
});
