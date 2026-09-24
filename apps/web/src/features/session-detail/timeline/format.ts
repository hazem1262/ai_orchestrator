import type { SessionStats, TimelineEvent } from '@orc/core';
import { mcpToolLabel } from '@orc/core/browser';

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatPct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`;
}

export function formatRate(tps: number | null): string {
  return tps === null ? '— tok/s' : `${tps.toFixed(1)} tok/s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function statsSummary(
  s: Pick<SessionStats, 'modelMs' | 'toolMs' | 'ttftMs' | 'tokensPerSec' | 'cacheHitRate'>,
): string[] {
  return [
    `model ${formatMs(s.modelMs)}`,
    `tools ${formatMs(s.toolMs)}`,
    `TTFT ≈${formatMs(s.ttftMs)}`,
    formatRate(s.tokensPerSec),
    `cache ${formatPct(s.cacheHitRate)}`,
  ];
}

/** One labelling rule for the whole app (Phase 1 core). */
export function toolLabel(tool: string): string {
  return mcpToolLabel(tool);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function inputSummary(e: TimelineEvent): string {
  const input = e.input;
  if (isObj(input)) {
    for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'description', 'skill']) {
      const v = input[k];
      if (typeof v === 'string') return v.slice(0, 120);
      if (k === 'command' && Array.isArray(v)) return v.join(' ').slice(0, 120);
    }
  }
  if (typeof input === 'string') return input.slice(0, 120);
  return input === null ? '' : JSON.stringify(input).slice(0, 120);
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}
