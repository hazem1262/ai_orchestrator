import { useUsage } from '@/api/queries/usage.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { formatPctValue, formatUsd, minutesUntil, quotaTone } from './format.ts';

const WARN_PCT = 0.8;

const TONE_CLASS: Record<'ok' | 'warn' | 'over', string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  over: 'bg-destructive',
};

function Bar({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const clamped = Math.min(100, Math.round(pct * 100));
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="inline-block h-1.5 w-14 overflow-hidden rounded bg-muted align-middle"
    >
      <span
        className={`block h-full ${TONE_CLASS[quotaTone(pct, WARN_PCT)]}`}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

/** Top-bar quota summary (F19). Updates live from the `usage.updated` WS event. */
export function QuotaBars() {
  const { data } = useUsage();
  if (!data) return null;
  const block = data.block;
  return (
    <section aria-label="Quota" className="flex items-center gap-2 text-xs text-muted-foreground">
      {block.active ? (
        <span
          className="flex items-center gap-1"
          title={`5-hour block resets in ${minutesUntil(block.end)} min`}
        >
          <span>
            5h {block.pctOfLimit === null ? formatUsd(block.costUsd) : formatPctValue(block.pctOfLimit)}
          </span>
          <Bar label="5-hour block" pct={block.pctOfLimit} />
        </span>
      ) : (
        <span>no active block</span>
      )}
      <span className="flex items-center gap-1" title="Last 7 days">
        <span>
          7d{' '}
          {data.week.pctOfLimit === null
            ? formatUsd(data.week.costUsd)
            : formatPctValue(data.week.pctOfLimit)}
        </span>
        <Bar label="7-day window" pct={data.week.pctOfLimit} />
      </span>
      {block.active ? <span title="Burn rate">{formatUsd(data.burnRateUsdPerHour)}/h</span> : null}
      {data.projectedBlockExhaustionAt !== null ? (
        <Badge variant="warning">runs out in {minutesUntil(data.projectedBlockExhaustionAt)} min</Badge>
      ) : null}
      {data.source === 'estimate' ? (
        <Badge variant="outline" title="No official quota source; figures are estimated from transcripts">
          estimated
        </Badge>
      ) : null}
    </section>
  );
}
