import type { UsageSnapshot } from '@orc/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { formatUsd, minutesUntil, quotaTone } from './format.ts';
import { QuotaBars } from './QuotaBars.tsx';

const base: UsageSnapshot = {
  source: 'estimate',
  generatedAt: '2026-09-18T09:00:00.000Z',
  block: {
    active: true,
    start: '2026-09-18T08:00:00.000Z',
    end: '2026-09-18T13:00:00.000Z',
    tokens: 10,
    costUsd: 12.5,
    pctOfLimit: 0.83,
  },
  week: { tokens: 100, costUsd: 88, pctOfLimit: null },
  burnRateUsdPerHour: 3.2,
  burnRateTokensPerMin: 2,
  projectedBlockExhaustionAt: '2026-09-18T11:00:00.000Z',
};

describe('quota formatting', () => {
  it('formats money, minutes and tone', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(null)).toBe('—');
    expect(minutesUntil('2026-09-18T09:30:00.000Z', Date.parse('2026-09-18T09:00:00.000Z'))).toBe(30);
    expect(minutesUntil('2026-09-18T08:00:00.000Z', Date.parse('2026-09-18T09:00:00.000Z'))).toBe(0);
    expect([quotaTone(0.5, 0.8), quotaTone(0.83, 0.8), quotaTone(1.2, 0.8), quotaTone(null, 0.8)]).toEqual([
      'ok',
      'warn',
      'over',
      'ok',
    ]);
  });
});

describe('QuotaBars', () => {
  it('shows the block percentage, burn rate, reset and the estimated label', async () => {
    setApiClientForTests(fakeApi({ usageGet: vi.fn(async () => base) }));
    renderP3(<QuotaBars />);
    const region = await screen.findByRole('region', { name: 'Quota' });
    expect(region).toHaveTextContent('5h 83%');
    expect(region).toHaveTextContent('7d $88.00');
    expect(region).toHaveTextContent('$3.20/h');
    expect(region).toHaveTextContent('estimated');
    expect(screen.getByRole('progressbar', { name: '5-hour block' })).toHaveAttribute('aria-valuenow', '83');
    expect(screen.getByTitle(/resets in \d+ min/)).toBeTruthy();
  });

  it('shows official figures and an inactive block without percentages', async () => {
    const off: UsageSnapshot = {
      ...base,
      source: 'official',
      block: { ...base.block, active: false, pctOfLimit: null },
      projectedBlockExhaustionAt: null,
    };
    setApiClientForTests(fakeApi({ usageGet: vi.fn(async () => off) }));
    renderP3(<QuotaBars />);
    const region = await screen.findByRole('region', { name: 'Quota' });
    expect(region).toHaveTextContent('no active block');
    expect(region).not.toHaveTextContent('estimated');
  });
});
