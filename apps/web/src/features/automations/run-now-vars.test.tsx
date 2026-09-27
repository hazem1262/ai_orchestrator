import type { AutomationRunDetail, AutomationWithStats, Template } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderP3 } from '@/test/p3-render.tsx';
import { AutomationsPage } from './AutomationsPage.tsx';

const PR = 'https://github.com/o/r/pull/1';

const base = (id: string, name: string, templateId: string): AutomationWithStats => ({
  id,
  name,
  enabled: true,
  trigger: { type: 'manual' },
  action: {
    templateId,
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 30,
    planApproval: false,
  },
  budgetUsd: 10,
  stats: { total: 0, success: 0, failed: 0, successRate: null, lastRunAt: null, monthSpendUsd: 0 },
  nextRunAt: null,
});

const needsVars = base('a1', 'Review PR', 'review-pr');
const noVars = base('a2', 'Tidy README', 'tidy');

const template = (id: string, vars: Template['vars']): Template => ({
  id,
  kind: 'workflow',
  label: id,
  prompt: vars.length ? `review {{${vars[0]}}}` : 'tidy the README',
  vars,
  defaultSource: 'claude',
  projectIds: 'all',
});

const run: AutomationRunDetail = {
  id: 'r1',
  automationId: 'a1',
  startedAt: '2026-09-17T09:00:00.000Z',
  endedAt: null,
  status: 'queued',
  sessionPk: null,
  costUsd: null,
  summary: null,
  triggerKey: 'manual:x',
  triggerSource: 'manual',
  vars: {},
  ptyId: null,
  worktreePath: null,
  prUrl: null,
  diffStat: null,
  error: null,
  rerunOf: null,
};

afterEach(() => setApiClientForTests(null));

function api() {
  const stubs = {
    automationsList: vi.fn(async () => [needsVars, noVars]),
    automationsSettingsGet: vi.fn(async () => ({
      enabled: true,
      maxConcurrent: 2,
      suggestionsEnabled: false,
    })),
    automationsRun: vi.fn(async (id: string) => ({ ...run, automationId: id })),
    automationsRuns: vi.fn(async () => []),
    suggestionsList: vi.fn(async () => []),
    projectsList: vi.fn(async () => []),
    templatesList: vi.fn(async () => [template('review-pr', ['prUrl']), template('tidy', [])]),
  };
  setApiClientForTests(fakeApi(stubs as never));
  return stubs;
}

async function runButtons(): Promise<HTMLButtonElement[]> {
  await screen.findByText('Review PR');
  const buttons = screen.getAllByRole('button', { name: 'Run now' }) as HTMLButtonElement[];
  await waitFor(() => expect(buttons.every((b) => !b.disabled)).toBe(true));
  return buttons;
}

describe('AutomationsPage — Run now with template vars', () => {
  it('asks for the template vars and sends them with the run', async () => {
    const stubs = api();
    renderP3(<AutomationsPage />);
    const [reviewRun] = await runButtons();
    fireEvent.click(reviewRun as HTMLButtonElement);

    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByLabelText('prUrl');
    expect(stubs.automationsRun).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: PR } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^(run|run now|start)$/i }));

    await waitFor(() => expect(stubs.automationsRun).toHaveBeenCalledWith('a1', { prUrl: PR }));
  });

  it('runs an automation whose template needs no vars directly, without a prompt', async () => {
    const stubs = api();
    renderP3(<AutomationsPage />);
    const [, tidyRun] = await runButtons();
    fireEvent.click(tidyRun as HTMLButtonElement);

    await waitFor(() => expect(stubs.automationsRun).toHaveBeenCalledTimes(1));
    expect(stubs.automationsRun.mock.calls[0]?.[0]).toBe('a2');
    expect(screen.queryByLabelText('prUrl')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
