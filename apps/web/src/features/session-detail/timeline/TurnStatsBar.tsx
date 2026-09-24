import type { TurnStats } from '@orc/core';
import { statsSummary } from './format.ts';

const EXPLAIN =
  'model = wall time − tool time · TTFT ≈ prompt → first recorded assistant block (upper bound) · tok/s = output ÷ model time · cache = read ÷ (input + read + write)';

export function TurnStatsBar({ stats }: { stats: TurnStats | undefined }) {
  if (!stats) return null;
  return (
    <p data-testid="turn-stats" title={EXPLAIN} className="text-xs text-neutral-500">
      {statsSummary(stats).join(' · ')}
    </p>
  );
}
