import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { AnalyticsPage } from './AnalyticsPage.tsx';

const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }));
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

function api(over: Partial<Parameters<typeof fakeApi>[0]> = {}) {
  return fakeApi({
    analyticsCost: vi.fn(async (p: { groupBy: string }) => ({
      rows:
        p.groupBy === 'project'
          ? [
              {
                key: 'wakecap',
                costUsd: 120,
                tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
                sessions: 5,
              },
            ]
          : [
              {
                key: '2026-09-15',
                costUsd: 120,
                tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
                sessions: 5,
              },
            ],
      estimated: true,
    })),
    analyticsTop: vi.fn(async () => ({
      sessions: [{ pk: 'claude:s1', name: 'Fix SLA', projectId: 'wakecap', costUsd: 60, tickets: ['SAF-1'] }],
      tickets: [{ ticket: 'SAF-1', costUsd: 60, sessions: 2 }],
      mergedPrs: 3,
      costPerMergedPrUsd: 20,
    })),
    analyticsTools: vi.fn(async () => [
      { bucket: '2026-09-15', kind: 'tool' as const, name: 'Bash', count: 4 },
    ]),
    analyticsTiming: vi.fn(async () => ({
      modelMs: 3000,
      toolMs: 1000,
      modelShare: 0.75,
      cacheHitTrend: [{ bucket: '2026-09-15', rate: 0.9 }],
    })),
    analyticsOutcomes: vi.fn(async () => ({
      sessions: 2,
      outcomes: { fully_achieved: 2 },
      friction: { buggy_code: 3 },
      goalCategories: {},
    })),
    analyticsWstack: vi.fn(async () => [
      { skill: 'ship', runs: 2, outcomes: { success: 2 }, avgDurationS: 30 },
    ]),
    analyticsDigestLatest: vi.fn(async () => null),
    analyticsDigestGenerate: vi.fn(async () => ({
      weekStart: '2026-09-07',
      markdown: '# Weekly digest — 2026-09-07',
      createdAt: 'x',
    })),
    usageGet: vi.fn(async () => ({
      source: 'estimate' as const,
      generatedAt: 't',
      block: {
        active: true,
        start: 't',
        end: '2026-09-18T13:00:00.000Z',
        tokens: 1,
        costUsd: 2,
        pctOfLimit: 0.2,
      },
      week: { tokens: 1, costUsd: 3, pctOfLimit: null },
      burnRateUsdPerHour: 1,
      burnRateTokensPerMin: 1,
      projectedBlockExhaustionAt: null,
    })),
    ...over,
  });
}

describe('AnalyticsPage', () => {
  it('shows totals, top lists, outcomes, wstack and the estimated label', async () => {
    setApiClientForTests(api());
    renderP3(<AnalyticsPage />);
    expect(await screen.findByText('$120.00')).toBeTruthy();
    expect(screen.getByText('estimated')).toBeTruthy();
    expect(await screen.findByText('$20.00')).toBeTruthy(); // cost per merged PR
    expect(screen.getByRole('link', { name: /Fix SLA/ })).toHaveAttribute('href', '/sessions/claude/s1');
    expect(screen.getByRole('link', { name: 'SAF-1' })).toHaveAttribute('href', '/streams/SAF-1');
    expect(screen.getByText('buggy_code')).toBeTruthy();
    expect(screen.getByText('ship')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy(); // model time share
  });

  it('changes the range and the grouping, and generates a digest', async () => {
    const client = api();
    setApiClientForTests(client);
    const user = userEvent.setup();
    renderP3(<AnalyticsPage />);
    await screen.findByText('$120.00');
    await user.selectOptions(screen.getByLabelText('Range'), '7');
    await user.selectOptions(screen.getByLabelText('Group by'), 'project');
    await waitFor(() =>
      expect(client.analyticsCost).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'project' })),
    );
    await user.click(screen.getByRole('button', { name: 'Generate weekly digest' }));
    expect(await screen.findByText(/# Weekly digest — 2026-09-07/)).toBeTruthy();
  });
});
