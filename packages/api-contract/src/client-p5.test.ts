import { describe, expect, it } from 'vitest';
import type { Caller, HttpMethod } from './client-p2.ts';
import { p5ClientMethods, withQuery } from './client-p5.ts';
import { UsageSnapshotSchema } from './routes/usage.ts';

const snapshot = {
  source: 'estimate',
  generatedAt: '2026-09-17T10:00:00.000Z',
  block: {
    active: true,
    start: '2026-09-17T09:00:00.000Z',
    end: '2026-09-17T14:00:00.000Z',
    tokens: 1200,
    costUsd: 1.5,
    pctOfLimit: null,
  },
  week: { tokens: 9000, costUsd: 30, pctOfLimit: null },
  burnRateUsdPerHour: 1.5,
  burnRateTokensPerMin: 20,
  projectedBlockExhaustionAt: null,
};

describe('p5ClientMethods', () => {
  it('builds paths, queries and bodies and validates responses', async () => {
    const calls: Array<{ method: HttpMethod; path: string; body: unknown }> = [];
    const call = (async (method: HttpMethod, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/api/usage') return snapshot;
      if (path.startsWith('/api/streams/')) {
        return { ticket: 'SAF-1', kind: 'pr', ref: 'u', origin: 'manual', excluded: false, createdAt: 'x' };
      }
      return [];
    }) as Caller;
    const c = p5ClientMethods(call);
    expect((await c.usageGet()).block.tokens).toBe(1200);
    await c.streamsLink('SAF-1', { kind: 'pr', ref: 'u' });
    await c.analyticsTools({ from: 'a', to: 'b', bucket: 'week' });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/api/streams/SAF-1/link',
      body: { kind: 'pr', ref: 'u' },
    });
    expect(calls[2]).toEqual({
      method: 'GET',
      path: '/api/analytics/tools?from=a&to=b&bucket=week',
      body: undefined,
    });
  });

  it('rejects a response that does not match the schema', async () => {
    const call = (async () => ({ ...snapshot, source: 'guess' })) as Caller;
    await expect(p5ClientMethods(call).usageGet()).rejects.toThrow();
    expect(() => UsageSnapshotSchema.parse({ ...snapshot, source: 'guess' })).toThrow();
  });

  it('drops empty query values', () => {
    expect(withQuery('/x', { a: 'b', c: undefined, d: '', e: 3, f: false })).toBe('/x?a=b&e=3&f=false');
    expect(withQuery('/x', {})).toBe('/x');
  });
});
