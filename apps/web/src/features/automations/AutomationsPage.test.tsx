import type { AutomationRunDetail, AutomationWithStats, Suggestion } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 as renderWithClient } from '@/test/p3-render.tsx';
import { AutomationsPage } from './AutomationsPage.tsx';
import { RunHistory } from './RunHistory.tsx';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

const auto: AutomationWithStats = {
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'github', event: 'check_failed' },
  action: {
    templateId: 'fix-ci',
    projectId: 'wakecap',
    useWorktree: true,
    headless: true,
    timeoutMin: 30,
    planApproval: true,
  },
  budgetUsd: 10,
  stats: {
    total: 3,
    success: 2,
    failed: 1,
    successRate: 2 / 3,
    lastRunAt: '2026-09-17T09:00:00.000Z',
    monthSpendUsd: 1.5,
  },
  nextRunAt: null,
};

const run: AutomationRunDetail = {
  id: 'r1',
  automationId: 'a1',
  startedAt: '2026-09-17T09:00:00.000Z',
  endedAt: null,
  status: 'awaiting_approval',
  sessionPk: 'claude:s1',
  costUsd: 0.2,
  summary: 'Plan: fix the lint step',
  triggerKey: 'k',
  triggerSource: 'github',
  vars: {},
  ptyId: null,
  worktreePath: null,
  prUrl: null,
  diffStat: null,
  error: null,
  rerunOf: null,
};

afterEach(() => setApiClientForTests(null));

function api(overrides: Record<string, unknown> = {}) {
  const stubs = {
    automationsList: vi.fn(async () => [auto]),
    automationsSettingsGet: vi.fn(async () => ({
      enabled: true,
      maxConcurrent: 2,
      suggestionsEnabled: false,
    })),
    automationsSettings: vi.fn(async () => ({ enabled: false, maxConcurrent: 2, suggestionsEnabled: false })),
    automationsSetEnabled: vi.fn(async () => ({ ...auto, enabled: false })),
    automationsRun: vi.fn(async () => ({ ...run, status: 'queued' as const })),
    automationsSave: vi.fn(async () => auto),
    automationsRuns: vi.fn(async () => [run]),
    automationsRunLog: vi.fn(async () => ({ lines: ['→ Bash', 'done'] })),
    automationsApprove: vi.fn(async () => ({ ...run, status: 'running' as const })),
    automationsReject: vi.fn(async () => ({ ...run, status: 'failed' as const })),
    automationsRerun: vi.fn(async () => run),
    suggestionsList: vi.fn(async (): Promise<Suggestion[]> => []),
    suggestionsRefresh: vi.fn(async () => ({ added: 0 })),
    suggestionsAccept: vi.fn(async () => ({ ptyId: 'pty-9', sessionPk: null })),
    suggestionsDismiss: vi.fn(),
    projectsList: vi.fn(async () => [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: ['/x'],
        hidden: false,
        lastActivityAt: null,
        sessionCount: 0,
      },
    ]),
    templatesList: vi.fn(async () => [
      {
        id: 'fix-ci',
        kind: 'preset' as const,
        label: 'Fix CI failure',
        prompt: 'fix {{prUrl}}',
        vars: ['prUrl' as const],
        defaultSource: 'claude' as const,
        projectIds: 'all' as const,
      },
    ]),
    ...overrides,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('AutomationsPage', () => {
  it('lists automations with trigger, success rate and spend, and runs or toggles them', async () => {
    const stubs = api();
    renderWithClient(<AutomationsPage />);
    expect(await screen.findByText('Fix CI')).toBeTruthy();
    expect(screen.getByText('GitHub: check failed')).toBeTruthy();
    expect(screen.getByText('Success 67%')).toBeTruthy();
    const runButton = screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement;
    await waitFor(() => expect(runButton.disabled).toBe(false));
    fireEvent.click(runButton);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('prUrl'), {
      target: { value: 'https://github.com/o/r/pull/7' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(stubs.automationsRun).toHaveBeenCalledWith('a1', { prUrl: 'https://github.com/o/r/pull/7' }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Fix CI' }));
    await waitFor(() => expect(stubs.automationsSetEnabled).toHaveBeenCalledWith('a1', false));
  });

  it('shows the master switch and disables Run now while it is off', async () => {
    const stubs = api({
      automationsSettingsGet: vi.fn(async () => ({
        enabled: false,
        maxConcurrent: 2,
        suggestionsEnabled: false,
      })),
    });
    renderWithClient(<AutomationsPage />);
    expect(await screen.findByText('Off — nothing runs')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automations enabled' }));
    await waitFor(() => expect(stubs.automationsSettings).toHaveBeenCalledWith({ enabled: true }));
  });

  it('creates an automation from the editor', async () => {
    const stubs = api({ automationsList: vi.fn(async () => []) });
    renderWithClient(<AutomationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning deps audit' } });
    await screen.findByRole('option', { name: 'Fix CI failure' });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'fix-ci' } });
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'cron' } });
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 8 * * 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(stubs.automationsSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Morning deps audit',
          trigger: { type: 'cron', cron: '0 8 * * 1' },
          action: expect.objectContaining({
            templateId: 'fix-ci',
            projectId: 'wakecap',
            useWorktree: true,
            headless: true,
          }),
        }),
      ),
    );
  });

  it('shows validation errors instead of saving', async () => {
    const stubs = api({ automationsList: vi.fn(async () => []) });
    renderWithClient(<AutomationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(stubs.automationsSave).not.toHaveBeenCalled();
  });
});

describe('RunHistory', () => {
  it('approves a waiting plan only after confirmation and shows the log', async () => {
    const stubs = api();
    const confirm = vi.fn(() => false);
    const { rerender } = renderWithClient(<RunHistory automation={auto} confirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Plan: fix the lint step'));
    expect(stubs.automationsApprove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    rerender(<RunHistory automation={auto} confirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(stubs.automationsApprove).toHaveBeenCalledWith('r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/done/)).toBeTruthy();
  });
});

describe('SuggestionsPanel', () => {
  it('accepts a suggestion after confirmation', async () => {
    const s: Suggestion = {
      id: 's1',
      source: 'linear',
      projectId: 'wakecap',
      title: 'SAF-1: Add retries',
      detail: 'https://linear.app/x',
      ticket: 'SAF-1',
      file: null,
      line: null,
      state: 'new',
      createdAt: '2026-09-17T09:00:00.000Z',
      decidedAt: null,
      runPtyId: null,
    };
    const stubs = api({ suggestionsList: vi.fn(async () => [s]) });
    renderWithClient(<SuggestionsPanel confirm={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start SAF-1: Add retries' }));
    await waitFor(() => expect(stubs.suggestionsAccept).toHaveBeenCalledWith('s1'));
  });
});
