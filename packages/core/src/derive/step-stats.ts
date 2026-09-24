import { emptyUsage, type TimelineEvent, type Usage } from '../types/index.ts';

export interface TurnStats {
  turn: number;
  agentId: string | null;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  modelMs: number;
  toolMs: number;
  reportedMs: number | null;
  ttftMs: number | null;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  usage: Usage;
  tokensPerSec: number | null;
  cacheHitRate: number | null;
}

export interface SessionStats {
  turns: number;
  wallMs: number;
  modelMs: number;
  toolMs: number;
  ttftMs: number | null;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  usage: Usage;
  tokensPerSec: number | null;
  cacheHitRate: number | null;
}

const ASSISTANT_KINDS = new Set<TimelineEvent['kind']>(['assistant_text', 'thinking', 'tool_call']);

export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .map(([a, b]) => [a, b] as const)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function isToolError(result: TimelineEvent): boolean {
  if (result.kind === 'error') return true;
  return typeof result.text === 'string' && result.text.trimStart().startsWith('<tool_use_error>');
}

export function cacheHitRate(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom > 0 ? u.cacheRead / denom : null;
}

export function tokensPerSec(outputTokens: number, modelMs: number): number | null {
  return outputTokens > 0 && modelMs > 0 ? outputTokens / (modelMs / 1000) : null;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  if (s.length % 2 === 1) return hi;
  const lo = s[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function statsForGroup(
  group: readonly TimelineEvent[],
  results: ReadonlyMap<string, TimelineEvent>,
): TurnStats | null {
  const first = group[0];
  if (!first) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const e of group) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (t < start) start = t;
    if (t > end) end = t;
  }
  if (!Number.isFinite(start)) return null;

  const intervals: Array<[number, number]> = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let apiErrors = 0;
  let reportedMs: number | null = null;
  let u = emptyUsage();
  for (const e of group) {
    if (e.usage) u = addUsage(u, e.usage);
    if (e.kind === 'system' && e.durationMs !== null) reportedMs = e.durationMs;
    if (e.kind === 'error' && e.toolUseId === null) apiErrors++;
    if (e.kind !== 'tool_call') continue;
    toolCalls++;
    const r = e.toolUseId ? results.get(e.toolUseId) : undefined;
    if (!r) continue;
    intervals.push([Date.parse(e.ts), Date.parse(r.ts)]);
    if (isToolError(r)) toolErrors++;
  }
  const toolMs = unionMs(intervals);
  const wallMs = end - start;
  const modelMs = Math.max(0, wallMs - toolMs);
  const prompt = group.find((e) => e.kind === 'prompt');
  const firstAssistant = group.find((e) => ASSISTANT_KINDS.has(e.kind));
  const ttftMs =
    prompt && firstAssistant ? Math.max(0, Date.parse(firstAssistant.ts) - Date.parse(prompt.ts)) : null;

  return {
    turn: first.turn,
    agentId: first.agentId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    wallMs,
    modelMs,
    toolMs,
    reportedMs,
    ttftMs,
    toolCalls,
    toolErrors,
    apiErrors,
    usage: u,
    tokensPerSec: tokensPerSec(u.output, modelMs),
    cacheHitRate: cacheHitRate(u),
  };
}

/** One entry per (agentId, turn), in order of first appearance (by seq). */
export function computeTurnStats(events: readonly TimelineEvent[]): TurnStats[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of sorted) {
    const key = `${e.agentId ?? ''}|${e.turn}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out: TurnStats[] = [];
  for (const g of groups.values()) {
    const s = statsForGroup(g, results);
    if (s) out.push(s);
  }
  return out;
}

export function computeSessionStats(turns: readonly TurnStats[]): SessionStats {
  let u = emptyUsage();
  let wallMs = 0;
  let modelMs = 0;
  let toolMs = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let apiErrors = 0;
  const ttfts: number[] = [];
  for (const t of turns) {
    u = addUsage(u, t.usage);
    wallMs += t.wallMs;
    modelMs += t.modelMs;
    toolMs += t.toolMs;
    toolCalls += t.toolCalls;
    toolErrors += t.toolErrors;
    apiErrors += t.apiErrors;
    if (t.ttftMs !== null) ttfts.push(t.ttftMs);
  }
  return {
    turns: turns.length,
    wallMs,
    modelMs,
    toolMs,
    ttftMs: median(ttfts),
    toolCalls,
    toolErrors,
    apiErrors,
    usage: u,
    tokensPerSec: tokensPerSec(u.output, modelMs),
    cacheHitRate: cacheHitRate(u),
  };
}
