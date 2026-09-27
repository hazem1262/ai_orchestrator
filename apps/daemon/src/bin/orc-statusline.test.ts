import type { UsageSnapshot } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { formatStatusline, runStatusline } from './orc-statusline.ts';

// No test here reaches a real daemon or a real token file: `fetchImpl` and `readToken` are always
// injected.

const usage: UsageSnapshot = {
  source: 'estimate',
  generatedAt: 't',
  block: { active: true, start: 's', end: 'e', tokens: 1, costUsd: 12.1, pctOfLimit: 0.183 },
  week: { tokens: 1, costUsd: 1, pctOfLimit: null },
  burnRateUsdPerHour: 3.2,
  burnRateTokensPerMin: 1,
  projectedBlockExhaustionAt: null,
};
const live = [
  {
    id: 's1',
    source: 'claude',
    usage: { costUsd: 0.42 },
    live: { status: 'busy', contextFill: 0.431 },
  },
  { id: 's2', source: 'claude', live: { status: 'waiting', contextFill: null } },
  { id: 's3', source: 'codex', live: { status: 'waiting', contextFill: null } },
];

describe('formatStatusline', () => {
  it('prints cost, context, block, burn and waiting', () => {
    expect(formatStatusline({ session_id: 's1', cost: { total_cost_usd: 0.4 } }, { usage, live })).toBe(
      '$0.40 · ctx 43% · 5h 18% est · $3.20/h · 2 waiting',
    );
  });
  it('falls back to block cost without a limit, and to offline', () => {
    const noPct = {
      ...usage,
      source: 'official' as const,
      block: { ...usage.block, pctOfLimit: null },
    };
    expect(formatStatusline({ session_id: 'x' }, { usage: noPct, live: [] })).toBe('5h $12.10 · $3.20/h');
    expect(formatStatusline({ cost: { total_cost_usd: 0.42 } }, { usage: null, live: null })).toBe(
      '$0.42 · orc offline',
    );
  });
});

describe('runStatusline', () => {
  it('calls the daemon with the token and forwards stdin', async () => {
    const calls: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        token: headers.get('x-orc-token'),
        body: init?.body ?? null,
      });
      if (url.endsWith('/api/usage')) return new Response(JSON.stringify(usage));
      if (url.endsWith('/api/live')) return new Response(JSON.stringify(live));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const stdin = JSON.stringify({ session_id: 's1', cost: { total_cost_usd: 0.4 } });
    const out = await runStatusline({
      stdin,
      env: { ORC_HOME: '/o', ORC_PORT: '5000' },
      fetchImpl,
      readToken: (f) => (f === '/o/token' ? 'tok' : null),
    });
    expect(out).toBe('$0.40 · ctx 43% · 5h 18% est · $3.20/h · 2 waiting');
    expect(calls.map((c) => [c.method, c.url, c.token])).toEqual([
      ['POST', 'http://127.0.0.1:5000/api/usage/official', 'tok'],
      ['GET', 'http://127.0.0.1:5000/api/usage', 'tok'],
      ['GET', 'http://127.0.0.1:5000/api/live', 'tok'],
    ]);
    expect(calls[0]?.body).toBe(stdin);
  });

  it('never throws when the daemon or token is missing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await runStatusline({ stdin: 'not json', env: {}, fetchImpl, readToken: () => 'x' })).toBe(
      'orc offline',
    );
    expect(await runStatusline({ stdin: '{}', env: {}, fetchImpl, readToken: () => null })).toBe(
      'orc offline',
    );
  });
});
