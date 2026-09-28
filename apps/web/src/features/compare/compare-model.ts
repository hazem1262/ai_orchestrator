import type { CompareEstimate, CompareVariantInput, CompareVariantView } from '@orc/api-contract';

export const VARIANT_PRESETS: ReadonlyArray<{ id: string; label: string; value: CompareVariantInput }> = [
  { id: 'opus', label: 'Claude Opus', value: { source: 'claude', model: 'claude-opus-5' } },
  { id: 'sonnet', label: 'Claude Sonnet', value: { source: 'claude', model: 'claude-sonnet-5' } },
  { id: 'claude', label: 'Claude (default model)', value: { source: 'claude' } },
  { id: 'codex', label: 'Codex', value: { source: 'codex' } },
];

const usd = (n: number) => `$${n.toFixed(2)}`;

export function formatEstimate(e: CompareEstimate): string {
  const cost =
    e.estimatedUsd === null || e.avgSessionCostUsd === null
      ? 'no cost history yet'
      : `≈ ${usd(e.estimatedUsd)} (median ${usd(e.avgSessionCostUsd)} × ${e.variants} over ${e.sample} recent sessions)`;
  return `Runs ${e.variants} agents · ${e.multiplier}× the cost of one session · ${cost}`;
}

export function budgetWarning(e: CompareEstimate): string | null {
  const pct = Math.round(e.budget.pct * 100);
  if (!e.budget.ok) return `Budget exceeded (${pct}%): the launch will be refused`;
  if (e.budget.pct >= 0.8) {
    return `Budget at ${pct}%${e.budget.limitUsd !== null ? ` of ${usd(e.budget.limitUsd)}` : ''}`;
  }
  return null;
}

export interface Highlights {
  cheapest: number | null;
  greenTests: number[];
  smallestDiff: number | null;
}

export const diffSize = (v: CompareVariantView) => (v.diff ? v.diff.insertions + v.diff.deletions : 0);

export function variantHighlights(vs: CompareVariantView[]): Highlights {
  const ok = vs.filter((v) => !v.error);
  const byCost = ok.filter((v) => v.costUsd !== null).sort((a, b) => (a.costUsd ?? 0) - (b.costUsd ?? 0));
  const bySize = ok.filter((v) => diffSize(v) > 0).sort((a, b) => diffSize(a) - diffSize(b));
  return {
    cheapest: byCost[0]?.index ?? null,
    greenTests: ok.filter((v) => v.tests && v.tests.failed === 0 && v.tests.passed > 0).map((v) => v.index),
    smallestDiff: bySize[0]?.index ?? null,
  };
}

/** The largest value of each metric across every variant, so a card's bar reads relative to the group. */
export interface MetricMax {
  cost: number;
  duration: number;
  diff: number;
}

export function metricMax(vs: CompareVariantView[]): MetricMax {
  return {
    cost: Math.max(0, ...vs.map((v) => v.costUsd ?? 0)),
    duration: Math.max(0, ...vs.map((v) => v.durationMs ?? 0)),
    diff: Math.max(0, ...vs.map(diffSize)),
  };
}

/** A bar's fill fraction for `value` against `max`; 0 when there is nothing to compare against. */
export function metricPct(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}
