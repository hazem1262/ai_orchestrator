import { describe, expect, it } from 'vitest';
import { renderWeeklyDigest } from './digest.ts';

const quota = {
  source: 'estimate' as const,
  generatedAt: '2026-09-21T09:00:00.000Z',
  block: {
    active: false,
    start: '2026-09-21T09:00:00.000Z',
    end: '2026-09-21T14:00:00.000Z',
    tokens: 0,
    costUsd: 0,
    pctOfLimit: null,
  },
  week: { tokens: 1_200_000, costUsd: 88.5, pctOfLimit: 0.42 },
  burnRateUsdPerHour: 0,
  burnRateTokensPerMin: 0,
  projectedBlockExhaustionAt: null,
};

describe('renderWeeklyDigest', () => {
  it('renders every section', () => {
    const md = renderWeeklyDigest({
      weekStart: '2026-09-14',
      weekEnd: '2026-09-20',
      spendUsd: 123.456,
      estimated: true,
      spendByProject: [
        {
          key: 'wakecap',
          costUsd: 100,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          sessions: 4,
        },
      ],
      shippedPrs: [
        {
          title: 'feat: SAF-1 x',
          url: 'https://github.com/o/r/pull/1',
          number: 1,
          mergedAt: '2026-09-15T10:00:00.000Z',
          tickets: ['SAF-1'],
        },
      ],
      stuckSessions: [
        { pk: 'claude:s', name: 'Fix CI', status: 'waiting', since: '2026-09-20T08:00:00.000Z' },
      ],
      topTickets: [{ ticket: 'SAF-1', costUsd: 40, sessions: 3 }],
      quota,
      budgets: [
        {
          budget: {
            id: 'b',
            scopeType: 'project',
            scopeId: 'wakecap',
            period: 'weekly',
            limitUsd: 200,
            origin: 'table',
          },
          spentUsd: 100,
          pct: 0.5,
          periodStart: '2026-09-14T00:00:00.000Z',
        },
      ],
    });
    expect(md).toContain('# Weekly digest — 2026-09-14 → 2026-09-20');
    expect(md).toContain('- Total: $123.46 (estimated)');
    expect(md).toContain('- wakecap: $100.00 (4 sessions)');
    expect(md).toContain('- [#1 feat: SAF-1 x](https://github.com/o/r/pull/1) — SAF-1 — merged 2026-09-15');
    expect(md).toContain('- Fix CI — waiting since 2026-09-20 08:00 UTC');
    expect(md).toContain('- SAF-1 — $40.00 (3 sessions)');
    expect(md).toContain('- 7 days: 1,200,000 tokens, $88.50, 42% of limit (estimated)');
    expect(md).toContain('- project wakecap weekly: $100.00 of $200.00 (50%)');
  });

  it('says none for empty sections', () => {
    const md = renderWeeklyDigest({
      weekStart: '2026-09-14',
      weekEnd: '2026-09-20',
      spendUsd: 0,
      estimated: false,
      spendByProject: [],
      shippedPrs: [],
      stuckSessions: [],
      topTickets: [],
      quota: { ...quota, source: 'official', week: { tokens: 0, costUsd: 0, pctOfLimit: null } },
      budgets: [],
    });
    expect(md.match(/- none/g)).toHaveLength(5);
    expect(md).toContain('- Total: $0.00\n');
    expect(md).toContain('- 7 days: 0 tokens, $0.00 (official)');
  });
});
