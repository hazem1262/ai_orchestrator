import { ApiRequestError, type AutomationRunDetail, type AutomationWithStats } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 } from '@/test/p3-render.tsx';
import { AutomationEditor } from './AutomationEditor.tsx';
import { RunHistory } from './RunHistory.tsx';

const auto: AutomationWithStats = {
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'manual' },
  action: {
    templateId: 'fix-ci',
    projectId: 'wakecap',
    useWorktree: true,
    headless: true,
    timeoutMin: 30,
    planApproval: true,
  },
  budgetUsd: 10,
  stats: { total: 0, success: 0, failed: 0, successRate: null, lastRunAt: null, monthSpendUsd: 0 },
  nextRunAt: null,
};

const run: AutomationRunDetail = {
  id: 'r1',
  automationId: 'a1',
  startedAt: '2026-09-17T09:00:00.000Z',
  endedAt: null,
  status: 'awaiting_approval',
  sessionPk: null,
  costUsd: null,
  summary: 'Plan: fix the lint step',
  triggerKey: 'k',
  triggerSource: 'manual',
  vars: {},
  ptyId: null,
  worktreePath: null,
  prUrl: null,
  diffStat: null,
  error: null,
  rerunOf: null,
};

const needsConfirm = (summary: string, extra: Record<string, unknown> = {}) =>
  new ApiRequestError(409, 'confirmation_required', 'confirmation required', { summary, ...extra });

afterEach(() => setApiClientForTests(null));

describe('daemon confirmation flow', () => {
  it('approves a plan through the 409 summary dialog when no confirm callback is given', async () => {
    const automationsApprove = vi.fn(async (_id: string, confirm?: boolean) => {
      if (confirm === false)
        throw needsConfirm('Approve the plan and let "Fix CI" implement it.', { plan: run.summary });
      return { ...run, status: 'running' as const };
    });
    setApiClientForTests(fakeApi({ automationsRuns: vi.fn(async () => [run]), automationsApprove }));
    renderP3(<RunHistory automation={auto} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve plan?' });
    expect(dialog.textContent).toContain('Approve the plan and let "Fix CI" implement it.');
    expect(dialog.textContent).toContain('Plan: fix the lint step');
    expect(automationsApprove).toHaveBeenCalledWith('r1', false);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(automationsApprove).toHaveBeenLastCalledWith('r1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('deletes an automation only after the 409 summary is confirmed', async () => {
    const automationsDelete = vi.fn(async (_id: string, confirm?: boolean) => {
      if (confirm !== true) throw needsConfirm('Delete the automation "Fix CI" and its run history');
      return { ok: true as const };
    });
    const onDone = vi.fn();
    setApiClientForTests(
      fakeApi({
        automationsDelete,
        projectsList: vi.fn(async () => []),
        templatesList: vi.fn(async () => []),
      }),
    );
    renderP3(<AutomationEditor projectId="wakecap" initial={auto} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete automation?' });
    expect(dialog.textContent).toContain('Delete the automation "Fix CI" and its run history');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
    await waitFor(() => expect(automationsDelete).toHaveBeenLastCalledWith('a1', true));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
