import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.ts';
import {
  activeBlock,
  BLOCK_MS,
  buildBlocks,
  burnRate,
  computeUsageSnapshot,
  contextFill,
  contextWindowFor,
  mapOfficialQuota,
  projectExhaustion,
  projectFromPct,
  quotaTokens,
  windowTotals,
} from './quota.ts';

const H = 3_600_000;
const t = (iso: string) => Date.parse(iso);
const PRICES = { 'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };

describe('pricing', () => {
  it('prices per million tokens and returns null for unknown models', () => {
    expect(
      estimateCostUsd(
        'claude-opus-5',
        { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 },
        PRICES,
      ),
    ).toBeCloseTo(8.5, 6);
    expect(
      estimateCostUsd(
        'claude-opus-5[1m]',
        { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        PRICES,
      ),
    ).toBeCloseTo(5, 6);
    expect(estimateCostUsd('gpt-x', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, PRICES)).toBeNull();
  });
});

describe('blocks', () => {
  const entries = [
    { ts: t('2026-09-17T09:20:00Z'), tokens: 100, costUsd: 1 },
    { ts: t('2026-09-17T11:00:00Z'), tokens: 200, costUsd: 2 },
    { ts: t('2026-09-17T14:10:00Z'), tokens: 50, costUsd: 0.5 }, // after 09:00+5h → new block at 14:00
    { ts: t('2026-09-17T08:00:00Z'), tokens: 10, costUsd: 0.1 }, // unsorted input
  ];

  it('groups entries into 5h blocks floored to the hour', () => {
    const blocks = buildBlocks(entries);
    expect(blocks.map((b) => new Date(b.start).toISOString())).toEqual([
      '2026-09-17T08:00:00.000Z',
      '2026-09-17T14:00:00.000Z',
    ]);
    expect(blocks[0]).toMatchObject({ tokens: 310, entries: 3, end: t('2026-09-17T08:00:00Z') + BLOCK_MS });
  });

  it('starts a new block after a 5h gap even inside the window', () => {
    const b = buildBlocks([
      { ts: t('2026-09-17T00:00:00Z'), tokens: 1, costUsd: 0 },
      { ts: t('2026-09-17T04:59:00Z'), tokens: 1, costUsd: 0 },
      { ts: t('2026-09-17T10:00:00Z'), tokens: 1, costUsd: 0 },
    ]);
    expect(b).toHaveLength(2);
  });

  it('finds the active block, totals, burn rate and projection', () => {
    const blocks = buildBlocks(entries);
    const now = t('2026-09-17T15:10:00Z');
    const act = activeBlock(blocks, now);
    expect(act?.start).toBe(t('2026-09-17T14:00:00Z'));
    expect(activeBlock(blocks, t('2026-09-17T20:00:00Z'))).toBeNull();
    expect(windowTotals(entries, t('2026-09-17T09:00:00Z'), now)).toEqual({ tokens: 350, costUsd: 3.5 });
    // act: 50 tokens, $0.5 over 60 min since first entry 14:10
    const rate = burnRate(act as NonNullable<typeof act>, now);
    expect(rate.usdPerHour).toBeCloseTo(0.5, 6);
    expect(rate.tokensPerMin).toBeCloseTo(50 / 60, 6);
    // limit 100 → 50 more tokens at 50/60 per min = 60 min → 16:10 (< end 19:00)
    expect(projectExhaustion(act as NonNullable<typeof act>, 100, rate.tokensPerMin, now)).toBe(
      t('2026-09-17T16:10:00Z'),
    );
    expect(projectExhaustion(act as NonNullable<typeof act>, 10_000, rate.tokensPerMin, now)).toBeNull();
    expect(projectExhaustion(act as NonNullable<typeof act>, null, rate.tokensPerMin, now)).toBeNull();
    expect(projectExhaustion(act as NonNullable<typeof act>, 40, rate.tokensPerMin, now)).toBe(now);
  });

  it('projects from an official percentage', () => {
    const start = t('2026-09-17T10:00:00Z');
    expect(projectFromPct(0.5, start, start + 5 * H, start + H)).toBe(start + 2 * H);
    expect(projectFromPct(0.1, start, start + 5 * H, start + H)).toBeNull();
    expect(projectFromPct(null, start, start + 5 * H, start + H)).toBeNull();
  });

  it('counts quota tokens without cache reads', () => {
    expect(quotaTokens({ input: 1, output: 2, cacheWrite: 3 })).toBe(6);
  });
});

describe('computeUsageSnapshot', () => {
  const now = t('2026-09-17T15:10:00Z');
  const entries = [
    { ts: t('2026-09-10T10:00:00Z'), tokens: 1000, costUsd: 10 }, // > 7 days before now → excluded from week
    { ts: t('2026-09-16T10:00:00Z'), tokens: 400, costUsd: 4 },
    { ts: t('2026-09-17T14:10:00Z'), tokens: 50, costUsd: 0.5 },
  ];

  it('labels estimates and leaves pct null without plan limits', () => {
    const s = computeUsageSnapshot({
      entries,
      now,
      limits: { blockTokenLimit: null, weekTokenLimit: null },
      official: null,
    });
    expect(s).toMatchObject({
      source: 'estimate',
      generatedAt: new Date(now).toISOString(),
      block: {
        active: true,
        start: '2026-09-17T14:00:00.000Z',
        end: '2026-09-17T19:00:00.000Z',
        tokens: 50,
        costUsd: 0.5,
        pctOfLimit: null,
      },
      week: { tokens: 450, costUsd: 4.5, pctOfLimit: null },
      projectedBlockExhaustionAt: null,
    });
  });

  it('computes pct from user plan limits', () => {
    const s = computeUsageSnapshot({
      entries,
      now,
      limits: { blockTokenLimit: 100, weekTokenLimit: 900 },
      official: null,
    });
    expect(s.block.pctOfLimit).toBeCloseTo(0.5, 6);
    expect(s.week.pctOfLimit).toBeCloseTo(0.5, 6);
    expect(s.projectedBlockExhaustionAt).toBe('2026-09-17T16:10:00.000Z');
  });

  it('reports an inactive block when nothing ran in the last 5h', () => {
    const s = computeUsageSnapshot({
      entries: entries.slice(0, 2),
      now,
      limits: { blockTokenLimit: null, weekTokenLimit: null },
      official: null,
    });
    expect(s.block).toMatchObject({
      active: false,
      tokens: 0,
      costUsd: 0,
      start: new Date(now).toISOString(),
    });
    expect(s.burnRateUsdPerHour).toBe(0);
  });

  it('prefers a fresh official sample and ignores a stale one', () => {
    const official = {
      at: '2026-09-17T15:05:00.000Z',
      blockPct: 0.42,
      blockResetsAt: '2026-09-17T18:30:00.000Z',
      weekPct: 0.1,
      weekResetsAt: null,
    };
    const s = computeUsageSnapshot({
      entries,
      now,
      limits: { blockTokenLimit: null, weekTokenLimit: null },
      official,
    });
    expect(s.source).toBe('official');
    expect(s.block).toMatchObject({
      pctOfLimit: 0.42,
      end: '2026-09-17T18:30:00.000Z',
      start: '2026-09-17T13:30:00.000Z',
    });
    expect(s.week.pctOfLimit).toBe(0.1);
    const stale = computeUsageSnapshot({
      entries,
      now,
      limits: { blockTokenLimit: null, weekTokenLimit: null },
      official: { ...official, at: '2026-09-17T12:00:00.000Z' },
    });
    expect(stale.source).toBe('estimate');
  });
});

describe('contextFill', () => {
  const windows = { 'claude-opus-5': 1_000_000, 'claude-haiku-4-5': 200_000 };
  it('uses the model window, falls back to the default, and bumps to 1M on overflow', () => {
    expect(
      contextFill({ input: 10, cacheRead: 90_000, cacheWrite: 10_000 }, 'claude-haiku-4-5', windows, 200_000),
    ).toEqual({ usedTokens: 100_010, windowTokens: 200_000, fill: 100_010 / 200_000 });
    expect(
      contextFill({ input: 0, cacheRead: 50_000, cacheWrite: 0 }, 'unknown-model', windows, 200_000)
        ?.windowTokens,
    ).toBe(200_000);
    expect(
      contextFill({ input: 0, cacheRead: 300_000, cacheWrite: 0 }, 'unknown-model', windows, 200_000)
        ?.windowTokens,
    ).toBe(1_000_000);
    expect(
      contextFill({ input: 0, cacheRead: 100, cacheWrite: 0 }, 'claude-haiku-4-5[1m]', windows, 200_000)
        ?.windowTokens,
    ).toBe(1_000_000);
    expect(
      contextFill({ input: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5', windows, 200_000),
    ).toBeNull();
    expect(contextWindowFor('claude-opus-5', windows, 200_000)).toBe(1_000_000);
    expect(contextWindowFor(null, windows, 200_000)).toBe(200_000);
  });
});

describe('mapOfficialQuota', () => {
  const paths = {
    blockPct: 'rate_limits.five_hour.used_percentage',
    blockResetsAt: 'rate_limits.five_hour.resets_at',
    weekPct: 'rate_limits.seven_day.used_percentage',
    weekResetsAt: null,
  };
  it('reads dotted paths, normalises percent values and epoch seconds', () => {
    const raw = {
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1789660800 },
        seven_day: { used_percentage: 0.3 },
      },
    };
    expect(mapOfficialQuota(raw, paths, '2026-09-17T10:00:00.000Z')).toEqual({
      at: '2026-09-17T10:00:00.000Z',
      blockPct: 0.42,
      blockResetsAt: new Date(1789660800 * 1000).toISOString(),
      weekPct: 0.3,
      weekResetsAt: null,
    });
  });
  it('returns null when nothing maps', () => {
    expect(mapOfficialQuota({ cost: 1 }, paths, '2026-09-17T10:00:00.000Z')).toBeNull();
    expect(
      mapOfficialQuota(
        { rate_limits: {} },
        { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null },
        'x',
      ),
    ).toBeNull();
  });
});
