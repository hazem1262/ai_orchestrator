import type { StreamDetail } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { StreamDetailPage } from './StreamDetailPage.tsx';

const detail: StreamDetail = {
  stream: {
    ticket: 'SAF-1787',
    projectId: 'wakecap',
    title: 'Exclude weekends',
    stage: 'backmerged',
    sessionIds: ['claude:s1'],
    prs: [{ repo: 'o/r', number: 231, url: 'https://x/231' }],
    plans: ['/w/plans/SAF-1787-x.md'],
    worktrees: ['/w/.worktrees/feat-SAF-1787'],
    costUsd: 12.5,
    lastActivityAt: '2026-09-17T10:00:00.000Z',
  },
  prsDetailed: [
    {
      pr: { repo: 'o/r', number: 231, url: 'https://x/231' },
      title: 'feat: SAF-1787',
      state: 'merged',
      headRef: 'feat/SAF-1787-x',
      baseRef: null,
      isBackmerge: false,
      checks: 'success',
      review: 'approved',
      updatedAt: '2026-09-16T10:00:00.000Z',
      mergedAt: '2026-09-16T10:00:00.000Z',
    },
    {
      pr: { repo: 'o/r', number: 240, url: 'https://x/240' },
      title: 'backmerge master → staging',
      state: 'merged',
      headRef: 'backmerge/SAF-1787',
      baseRef: 'staging',
      isBackmerge: true,
      checks: 'pending',
      review: 'none',
      updatedAt: '2026-09-17T09:00:00.000Z',
      mergedAt: '2026-09-17T09:00:00.000Z',
    },
  ],
  links: [
    {
      ticket: 'SAF-1787',
      kind: 'session',
      ref: 'claude:s1',
      origin: 'auto',
      excluded: false,
      createdAt: 't',
    },
    {
      ticket: 'SAF-1787',
      kind: 'session',
      ref: 'claude:s9',
      origin: 'manual',
      excluded: true,
      createdAt: 't',
    },
  ],
  timeline: [
    {
      ts: '2026-09-17T09:00:00.000Z',
      kind: 'pr',
      title: '#240 backmerge master → staging',
      ref: 'https://x/240',
      detail: 'merged · backmerge · checks pending · review none',
    },
    {
      ts: '2026-09-16T10:00:00.000Z',
      kind: 'recap',
      title: 'Recap',
      ref: 'claude:s1',
      detail: 'Excluded weekends from the SLA clock.',
    },
  ],
  goal: {
    id: 'g1',
    targetType: 'stream',
    targetId: 'SAF-1787',
    objective: 'ship the weekend rule',
    state: 'complete',
    blockedReason: null,
    updatedAt: 't',
  },
  handoff: {
    id: 'h1',
    sessionId: 'claude:s1',
    status: 'ready_for_review',
    summary: 'Done.',
    evidence: [],
    files: [],
    nextSteps: ['Watch staging'],
    blockers: [],
    links: [],
    createdAt: 't',
  },
  budget: { ok: true, pct: 0.25, limitUsd: 50 },
};

function api(over = {}) {
  return fakeApi({
    streamsGet: vi.fn(async () => detail),
    streamsLink: vi.fn(
      async (ticket: string, b: { kind: string; ref: string }) =>
        ({ ticket, ...b, origin: 'manual', excluded: false, createdAt: 't' }) as never,
    ),
    streamsUnlink: vi.fn(
      async (ticket: string, b: { kind: string; ref: string }) =>
        ({ ticket, ...b, origin: 'manual', excluded: true, createdAt: 't' }) as never,
    ),
    goalsGet: vi.fn(async () => ({ goal: detail.goal, prefill: 'SAF-1787' })),
    goalsSet: vi.fn(async () => detail.goal as never),
    ...over,
  });
}

describe('StreamDetailPage', () => {
  it('answers what happened, what it cost and what is next on one screen', async () => {
    setApiClientForTests(api());
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    expect(await screen.findByRole('heading', { name: /SAF-1787/ })).toBeTruthy();
    expect(screen.getByText('Exclude weekends')).toBeTruthy();
    expect(screen.getByLabelText('Stage')).toHaveTextContent('Backmerged');
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('25% of $50.00')).toBeTruthy();
    expect(screen.getByText('Excluded weekends from the SLA clock.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#231 feat: SAF-1787' })).toHaveAttribute(
      'href',
      'https://x/231',
    );
    expect(screen.getByText('backmerge')).toBeTruthy();
    expect(screen.getByText('Watch staging')).toBeTruthy();
    expect(screen.getByLabelText('Goal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'claude:s1' })).toHaveAttribute('href', '/sessions/claude/s1');
  });

  it('links and unlinks by hand', async () => {
    const client = api();
    setApiClientForTests(client);
    const user = userEvent.setup();
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    await user.selectOptions(await screen.findByLabelText('Link kind'), 'session');
    await user.type(screen.getByLabelText('Link reference'), 'claude:s5');
    await user.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(client.streamsLink).toHaveBeenCalledWith('SAF-1787', { kind: 'session', ref: 'claude:s5' }),
    );
    await user.click(screen.getByRole('button', { name: 'Unlink session claude:s1' }));
    expect(client.streamsUnlink).toHaveBeenCalledWith('SAF-1787', { kind: 'session', ref: 'claude:s1' });
    expect(screen.getByText(/claude:s9 \(unlinked\)/)).toBeTruthy();
  });

  it('links back to Streams and shows a budget bar sized to the spend', async () => {
    setApiClientForTests(api());
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    await screen.findByRole('heading', { name: /SAF-1787/ });
    expect(screen.getByRole('link', { name: 'Streams' })).toHaveAttribute('href', '/streams');
    const bar = screen.getByRole('progressbar', { name: 'Budget' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
  });

  it('strips XML-ish prompt wrappers from the stream title, and falls back for no title', async () => {
    setApiClientForTests(
      api({
        streamsGet: vi.fn(async () => ({
          ...detail,
          stream: {
            ...detail.stream,
            title: '<command-message>marauder is running…</command-message>\n\nExclude weekends',
          },
        })),
      }),
    );
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    expect(await screen.findByText('Exclude weekends')).toBeTruthy();
    expect(screen.queryByText(/<command-message>/)).toBeNull();
  });

  it('shows an alert with a retry when the stream fails to load', async () => {
    const streamsGet = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(detail);
    setApiClientForTests(api({ streamsGet }));
    const user = userEvent.setup();
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load SAF-1787.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: /SAF-1787/ });
  });
});
