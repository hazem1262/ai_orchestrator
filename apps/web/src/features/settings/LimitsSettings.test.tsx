import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { LimitsSettings } from './LimitsSettings.tsx';

const limits = {
  quotaSource: 'estimate' as const,
  officialFieldPaths: { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null },
  blockTokenLimit: null,
  weekTokenLimit: null,
  warnPct: 0.8,
  contextWindows: { 'claude-opus-5': 1000000 },
  defaultContextWindow: 200000,
  contextWarnFill: 0.85,
  pricing: {},
};
const budgets = [
  {
    budget: {
      id: 'config:wakecap:daily',
      scopeType: 'project' as const,
      scopeId: 'wakecap',
      period: 'daily' as const,
      limitUsd: 50,
      origin: 'config' as const,
    },
    spentUsd: 41,
    pct: 0.82,
    periodStart: '2026-09-18T00:00:00.000Z',
  },
  {
    budget: {
      id: 'b2',
      scopeType: 'ticket' as const,
      scopeId: 'SAF-1',
      period: 'weekly' as const,
      limitUsd: 20,
      origin: 'table' as const,
    },
    spentUsd: 2,
    pct: 0.1,
    periodStart: '2026-09-14T00:00:00.000Z',
  },
];

describe('LimitsSettings', () => {
  it('saves plan limits and shows budgets with spend', async () => {
    const settingsUpdate = vi.fn(async () => ({ limits }) as never);
    setApiClientForTests(
      fakeApi({
        settingsGet: vi.fn(async () => ({ limits }) as never),
        settingsUpdate,
        usageBudgets: vi.fn(async () => budgets),
        usageConcurrency: vi.fn(async () => [{ projectId: 'wakecap', owned: 2, max: 6 }]),
        usageBudgetUpsert: vi.fn(async () => budgets[1]?.budget as never),
        usageBudgetDelete: vi.fn(async () => ({ ok: true as const })),
      }),
    );
    const user = userEvent.setup();
    renderP3(<LimitsSettings />);
    await user.type(await screen.findByLabelText('5-hour token limit'), '88000000');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() =>
      expect(settingsUpdate).toHaveBeenCalledWith({ limits: { ...limits, blockTokenLimit: 88000000 } }),
    );
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('wakecap 2 / 6 owned sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete budget SAF-1 weekly' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete budget wakecap daily' })).toBeNull();
  });

  it('adds a ticket budget', async () => {
    const usageBudgetUpsert = vi.fn(async () => budgets[1]?.budget as never);
    setApiClientForTests(
      fakeApi({
        settingsGet: vi.fn(async () => ({ limits }) as never),
        settingsUpdate: vi.fn(async () => ({ limits }) as never),
        usageBudgets: vi.fn(async () => []),
        usageConcurrency: vi.fn(async () => []),
        usageBudgetUpsert,
        usageBudgetDelete: vi.fn(async () => ({ ok: true as const })),
      }),
    );
    const user = userEvent.setup();
    renderP3(<LimitsSettings />);
    await user.selectOptions(await screen.findByLabelText('Scope'), 'ticket');
    await user.type(screen.getByLabelText('Scope id'), 'SAF-1');
    await user.selectOptions(screen.getByLabelText('Period'), 'weekly');
    await user.clear(screen.getByLabelText('Limit (USD)'));
    await user.type(screen.getByLabelText('Limit (USD)'), '20');
    await user.click(screen.getByRole('button', { name: 'Add budget' }));
    await waitFor(() =>
      expect(usageBudgetUpsert).toHaveBeenCalledWith({
        scopeType: 'ticket',
        scopeId: 'SAF-1',
        period: 'weekly',
        limitUsd: 20,
      }),
    );
  });
});
