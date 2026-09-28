import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          : p.groupBy === 'model'
            ? [
                {
                  key: 'sonnet',
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
  it('shows totals, top lists, outcomes, wstack and the estimated hint', async () => {
    setApiClientForTests(api());
    renderP3(<AnalyticsPage />);
    expect(await screen.findByText('$120.00')).toBeTruthy();
    expect(screen.getByText(/estimated/)).toBeTruthy();
    expect(await screen.findByText('$20.00')).toBeTruthy(); // cost per merged PR
    expect(screen.getByRole('link', { name: /Fix SLA/ })).toHaveAttribute('href', '/sessions/claude/s1');
    expect(screen.getByRole('link', { name: 'SAF-1' })).toHaveAttribute('href', '/streams/SAF-1');
    expect(screen.getByText('ship')).toBeTruthy();
    expect(screen.getByText(/Model time 75% of wall clock/)).toBeTruthy();
  });

  it('humanizes snake_case outcome and friction labels instead of showing the raw recap keys', async () => {
    setApiClientForTests(api());
    renderP3(<AnalyticsPage />);
    await screen.findByText('$120.00');
    expect(screen.getByText('Buggy code')).toBeTruthy();
    expect(screen.queryByText('buggy_code')).toBeNull();
    expect(screen.queryByText('fully_achieved')).toBeNull();
  });

  it('changes the range and the grouping, and generates a digest', async () => {
    const client = api();
    setApiClientForTests(client);
    const user = userEvent.setup();
    renderP3(<AnalyticsPage />);
    await screen.findByText('$120.00');
    await user.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await user.selectOptions(screen.getByLabelText('By'), 'model');
    await waitFor(() =>
      expect(client.analyticsCost).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'model' })),
    );
    expect(await screen.findByText('Spend by model')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Generate weekly digest' }));
    expect(await screen.findByText(/# Weekly digest — 2026-09-07/)).toBeTruthy();
  });

  describe('theme reactivity', () => {
    afterEach(() => {
      document.documentElement.classList.remove('dark');
    });

    it('re-reads the chart tokens and redraws when the app toggles the dark class on <html>', async () => {
      const style = document.createElement('style');
      style.textContent = `
        :root { --chart-1: rgb(1,2,3); --chart-2: rgb(4,5,6); --chart-3: rgb(7,8,9); --chart-4: rgb(10,11,12); --chart-5: rgb(13,14,15); --foreground: rgb(0,0,0); --muted-foreground: rgb(50,50,50); --border: rgb(200,200,200); }
        .dark { --chart-1: rgb(101,102,103); --chart-2: rgb(104,105,106); --chart-3: rgb(107,108,109); --chart-4: rgb(110,111,112); --chart-5: rgb(113,114,115); --foreground: rgb(255,255,255); --muted-foreground: rgb(180,180,180); --border: rgb(60,60,60); }
      `;
      document.head.appendChild(style);
      try {
        setApiClientForTests(api());
        renderP3(<AnalyticsPage />);
        await screen.findByText('$120.00');

        const before = JSON.stringify(chart.setOption.mock.calls);
        expect(before).toContain('rgb(1,2,3)');
        expect(before).not.toContain('rgb(101,102,103)');
        const callsBefore = chart.setOption.mock.calls.length;

        await act(async () => {
          document.documentElement.classList.add('dark');
          await Promise.resolve();
        });

        expect(chart.setOption.mock.calls.length).toBeGreaterThan(callsBefore);
        const after = JSON.stringify(chart.setOption.mock.calls.slice(callsBefore));
        expect(after).toContain('rgb(101,102,103)');
      } finally {
        style.remove();
      }
    });
  });
});
