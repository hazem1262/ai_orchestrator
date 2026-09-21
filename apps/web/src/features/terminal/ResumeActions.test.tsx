import { ApiRequestError } from '@orc/api-contract';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminals.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ResumeActions, type ResumeTarget } from './ResumeActions.tsx';

const target: ResumeTarget = {
  source: 'claude',
  id: 's1',
  availability: 'resumable',
  live: null,
  title: 'Fix SLA',
};
const live = (o: Partial<NonNullable<ResumeTarget['live']>>): NonNullable<ResumeTarget['live']> => ({
  pid: 41001,
  status: 'waiting',
  waitingFor: null,
  since: 'now',
  ownership: 'observed',
  ptyId: null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
  ...o,
});

describe('ResumeActions', () => {
  beforeEach(() => useTerminalStore.setState({ tabs: [], active: null }));

  it('resumes and forks into terminal tabs', async () => {
    const sessionsResume = vi
      .fn()
      .mockResolvedValueOnce({ ptyId: 'p1' })
      .mockResolvedValueOnce({ ptyId: 'p2' });
    renderWithProviders(<ResumeActions target={target} />, { api: createFakeApi({ sessionsResume }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p1'));
    expect(sessionsResume).toHaveBeenCalledWith('claude', 's1', { mode: 'embedded', cols: 120, rows: 36 });
    await userEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p2'));
    expect(sessionsResume).toHaveBeenLastCalledWith('claude', 's1', {
      mode: 'embedded',
      fork: true,
      cols: 120,
      rows: 36,
    });
    expect(useTerminalStore.getState().tabs).toEqual([
      { ptyId: 'p1', title: 'Fix SLA' },
      { ptyId: 'p2', title: 'Fork: Fix SLA' },
    ]);
  });

  it('focuses the existing tab when the app already owns the session', async () => {
    const sessionsResume = vi.fn(async () => {
      throw new ApiRequestError(409, 'session_live', 'already open', { ptyId: 'p9', ownership: 'owned' });
    });
    renderWithProviders(<ResumeActions target={target} />, { api: createFakeApi({ sessionsResume }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p9'));
    expect(screen.getByRole('status').textContent).toContain('Already open in the app');
  });

  it('shows "Show terminal" for owned sessions and pops out with popOut', async () => {
    const user = userEvent.setup();
    useTerminalStore.getState().open('p5', 'Fix SLA');
    const sessionsResume = vi.fn(async () => ({
      launched: 'external' as const,
      command: 'cd /w && claude --resume s1',
    }));
    const owned = { ...target, live: live({ ownership: 'owned', ptyId: 'p5', status: 'idle', pid: 1 }) };
    renderWithProviders(<ResumeActions target={owned} />, { api: createFakeApi({ sessionsResume }) });
    useTerminalStore.setState({ active: null });
    await user.click(await screen.findByRole('button', { name: 'Show terminal' }));
    expect(useTerminalStore.getState().active).toBe('p5');
    await user.click(screen.getByRole('button', { name: 'Pop out' }));
    await waitFor(() =>
      expect(sessionsResume).toHaveBeenCalledWith('claude', 's1', { mode: 'external', popOut: true }),
    );
    await waitFor(() => expect(useTerminalStore.getState().tabs).toEqual([]));
    expect(await navigator.clipboard.readText()).toBe('cd /w && claude --resume s1');
    expect(screen.getByRole('status').textContent).toContain('cd /w && claude --resume s1');
  });

  it('guards sessions running elsewhere, offers adopt when ended, and disables prompts-only', async () => {
    const { unmount } = renderWithProviders(<ResumeActions target={{ ...target, live: live({}) }} />);
    expect(await screen.findByRole('button', { name: 'Resume' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Fork' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Running in another terminal (pid 41001)')).toBeTruthy();
    unmount();

    const ended = renderWithProviders(
      <ResumeActions target={{ ...target, live: live({ status: 'ended' }) }} />,
    );
    expect(await screen.findByRole('button', { name: 'Adopt' })).toHaveProperty('disabled', false);
    ended.unmount();

    renderWithProviders(<ResumeActions target={{ ...target, availability: 'prompts-only' }} compact />);
    expect(await screen.findByRole('button', { name: 'Resume' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();
  });
});
