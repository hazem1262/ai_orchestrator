import type { Usage } from '../types/index.ts';

/** USD per 1M tokens. */
export type PriceTable = Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
>;

export function estimateCostUsd(
  model: string,
  u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  prices: PriceTable,
): number | null {
  const p = prices[model] ?? prices[model.replace(/\[1m\]$/, '')];
  if (!p) return null;
  return (
    (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) /
    1_000_000
  );
}
