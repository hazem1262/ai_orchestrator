import type { WorkStream } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useStreamViewStore } from '../../stores/streams.ts';
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
  // the view store is a module-level singleton; reset it so one test's choice doesn't leak into the next
  beforeEach(() => {
    useStreamViewStore.setState({ view: 'list' });
  });

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

  it('switches to the board view and back, and remembers the choice', async () => {
    setApiClientForTests(
      fakeApi({ streamsList: vi.fn(async () => streams), streamsRefresh: vi.fn(async () => streams) }),
    );
    const user = userEvent.setup();
    const first = renderP3(<StreamsPage />);
    // the List/Board switch is a radiogroup (shadcn ToggleGroup, exclusive selection)
    await user.click(await screen.findByRole('radio', { name: 'Board' }));
    expect(await screen.findByRole('region', { name: 'Merged' })).toBeTruthy();
    expect(window.localStorage.getItem('orc.stream-view')).toBe('kanban');
    first.unmount();
    renderP3(<StreamsPage />);
    expect(await screen.findByRole('region', { name: 'Planned' })).toBeTruthy();
  });

  it('strips XML-ish prompt wrappers from a raw title, and falls back for no title', async () => {
    const base = streams[0] as WorkStream;
    const other = streams[1] as WorkStream;
    const wrapped: WorkStream = {
      ...base,
      ticket: 'SAF-2000',
      title: '<command-message>marauder is running…</command-message>\n\nTake ticket SAF-2000 end to end',
    };
    setApiClientForTests(
      fakeApi({
        streamsList: vi.fn(async () => [wrapped, other]),
        streamsRefresh: vi.fn(async () => streams),
      }),
    );
    renderP3(<StreamsPage />);
    expect(await screen.findByText('Take ticket SAF-2000 end to end')).toBeTruthy();
    expect(screen.queryByText(/<command-message>/)).toBeNull();
    expect(screen.getByText('Untitled stream')).toBeTruthy();
  });

  it('paginates the list at 15 rows a page', async () => {
    const base = streams[0] as WorkStream;
    const many: WorkStream[] = Array.from({ length: 17 }, (_, i) => ({
      ...base,
      ticket: `SAF-${1000 + i}`,
      title: `Stream number ${i}`,
      lastActivityAt: new Date(2026, 8, 17, 10, 0, i).toISOString(),
    }));
    setApiClientForTests(
      fakeApi({ streamsList: vi.fn(async () => many), streamsRefresh: vi.fn(async () => streams) }),
    );
    const user = userEvent.setup();
    renderP3(<StreamsPage />);
    expect(await screen.findByText('1–15 of 17')).toBeTruthy();
    const previous = screen.getByRole('button', { name: /Previous/ });
    const next = screen.getByRole('button', { name: /Next/ });
    expect(previous).toBeDisabled();
    expect(next).not.toBeDisabled();
    // 17 streams sorted newest-first: the last one created (index 16) leads page 1.
    expect(screen.getByText('Stream number 16')).toBeTruthy();
    expect(screen.queryByText('Stream number 0')).toBeNull();
    await user.click(next);
    expect(await screen.findByText('16–17 of 17')).toBeTruthy();
    expect(screen.getByText('Stream number 0')).toBeTruthy();
    expect(next).toBeDisabled();
  });
});
