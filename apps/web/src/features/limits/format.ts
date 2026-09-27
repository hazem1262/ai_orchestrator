export function formatUsd(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(2)}`;
}

export function formatPctValue(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function minutesUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
}

export function quotaTone(pct: number | null, warnPct: number): 'ok' | 'warn' | 'over' {
  if (pct === null) return 'ok';
  if (pct >= 1) return 'over';
  return pct >= warnPct ? 'warn' : 'ok';
}
