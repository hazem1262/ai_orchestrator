import type { OfficialQuotaSample, Usage, UsageSnapshot } from '../types/index.ts';

export const BLOCK_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
export const OFFICIAL_MAX_AGE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const MIN_ELAPSED_MS = 60_000;

export interface QuotaEntry {
  ts: number;
  tokens: number;
  costUsd: number;
}
export interface QuotaBlock {
  start: number;
  end: number;
  firstTs: number;
  lastTs: number;
  tokens: number;
  costUsd: number;
  entries: number;
}
export interface QuotaLimits {
  blockTokenLimit: number | null;
  weekTokenLimit: number | null;
}
export interface OfficialFieldPaths {
  blockPct: string | null;
  blockResetsAt: string | null;
  weekPct: string | null;
  weekResetsAt: string | null;
}

export function quotaTokens(u: Pick<Usage, 'input' | 'output' | 'cacheWrite'>): number {
  return u.input + u.output + u.cacheWrite;
}

export function buildBlocks(entries: QuotaEntry[]): QuotaBlock[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const blocks: QuotaBlock[] = [];
  for (const e of sorted) {
    const cur = blocks.at(-1);
    if (!cur || e.ts >= cur.end || e.ts - cur.lastTs >= BLOCK_MS) {
      const start = Math.floor(e.ts / HOUR_MS) * HOUR_MS;
      blocks.push({
        start,
        end: start + BLOCK_MS,
        firstTs: e.ts,
        lastTs: e.ts,
        tokens: e.tokens,
        costUsd: e.costUsd,
        entries: 1,
      });
    } else {
      cur.lastTs = e.ts;
      cur.tokens += e.tokens;
      cur.costUsd += e.costUsd;
      cur.entries += 1;
    }
  }
  return blocks;
}

export function activeBlock(blocks: QuotaBlock[], now: number): QuotaBlock | null {
  const last = blocks.at(-1);
  if (!last) return null;
  return now < last.end && now - last.lastTs < BLOCK_MS ? last : null;
}

export function windowTotals(
  entries: QuotaEntry[],
  from: number,
  to: number,
): { tokens: number; costUsd: number } {
  let tokens = 0;
  let costUsd = 0;
  for (const e of entries) {
    if (e.ts >= from && e.ts <= to) {
      tokens += e.tokens;
      costUsd += e.costUsd;
    }
  }
  return { tokens, costUsd };
}

export function burnRate(block: QuotaBlock, now: number): { usdPerHour: number; tokensPerMin: number } {
  const elapsed = Math.max(MIN_ELAPSED_MS, Math.min(now, block.end) - block.firstTs);
  return { usdPerHour: block.costUsd / (elapsed / HOUR_MS), tokensPerMin: block.tokens / (elapsed / 60_000) };
}

export function projectExhaustion(
  block: QuotaBlock,
  limitTokens: number | null,
  tokensPerMin: number,
  now: number,
): number | null {
  if (limitTokens === null) return null;
  if (block.tokens >= limitTokens) return now;
  if (tokensPerMin <= 0) return null;
  const at = now + ((limitTokens - block.tokens) / tokensPerMin) * 60_000;
  return at < block.end ? Math.round(at) : null;
}

export function projectFromPct(pct: number | null, start: number, end: number, now: number): number | null {
  if (pct === null || pct <= 0) return null;
  if (pct >= 1) return now;
  const elapsed = Math.max(MIN_ELAPSED_MS, now - start);
  const at = start + elapsed / pct;
  return at < end ? Math.round(at) : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function computeUsageSnapshot(i: {
  entries: QuotaEntry[];
  now: number;
  limits: QuotaLimits;
  official: OfficialQuotaSample | null;
}): UsageSnapshot {
  const { entries, now, limits } = i;
  const act = activeBlock(buildBlocks(entries), now);
  const week = windowTotals(entries, now - WEEK_MS, now);
  const rate = act ? burnRate(act, now) : { usdPerHour: 0, tokensPerMin: 0 };
  let start = act ? act.start : now;
  let end = act ? act.end : now + BLOCK_MS;
  let blockPct = act && limits.blockTokenLimit !== null ? act.tokens / limits.blockTokenLimit : null;
  let weekPct = limits.weekTokenLimit !== null ? week.tokens / limits.weekTokenLimit : null;
  let projected = act ? projectExhaustion(act, limits.blockTokenLimit, rate.tokensPerMin, now) : null;
  let source: UsageSnapshot['source'] = 'estimate';

  const off = i.official;
  if (off && now - Date.parse(off.at) <= OFFICIAL_MAX_AGE_MS) {
    source = 'official';
    if (off.blockPct !== null) blockPct = off.blockPct;
    if (off.weekPct !== null) weekPct = off.weekPct;
    if (off.blockResetsAt !== null) {
      end = Date.parse(off.blockResetsAt);
      start = end - BLOCK_MS;
    }
    projected = projectFromPct(blockPct, start, end, now);
  }

  return {
    source,
    generatedAt: iso(now),
    block: {
      active: act !== null || source === 'official',
      start: iso(start),
      end: iso(end),
      tokens: act?.tokens ?? 0,
      costUsd: act?.costUsd ?? 0,
      pctOfLimit: blockPct,
    },
    week: { tokens: week.tokens, costUsd: week.costUsd, pctOfLimit: weekPct },
    burnRateUsdPerHour: rate.usdPerHour,
    burnRateTokensPerMin: rate.tokensPerMin,
    projectedBlockExhaustionAt: projected === null ? null : iso(projected),
  };
}

const ONE_MILLION = 1_000_000;

/** Context window for a model id: `[1m]` suffix → 1M, else the configured table, else the default. */
export function contextWindowFor(
  model: string | null,
  windows: Record<string, number>,
  defaultWindow: number,
): number {
  if (model === null) return defaultWindow;
  if (model.endsWith('[1m]')) return ONE_MILLION;
  return windows[model] ?? defaultWindow;
}

export function contextFill(
  u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>,
  model: string | null,
  windows: Record<string, number>,
  defaultWindow: number,
): { usedTokens: number; windowTokens: number; fill: number } | null {
  const usedTokens = u.input + u.cacheRead + u.cacheWrite;
  if (usedTokens === 0) return null;
  let windowTokens = contextWindowFor(model, windows, defaultWindow);
  if (usedTokens > windowTokens && windowTokens < ONE_MILLION) windowTokens = ONE_MILLION;
  return { usedTokens, windowTokens, fill: Math.min(1, usedTokens / windowTokens) };
}

export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pctAt(raw: unknown, path: string | null): number | null {
  if (path === null) return null;
  const v = readPath(raw, path);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v > 1 ? v / 100 : v;
}

function timeAt(raw: unknown, path: string | null): string | null {
  if (path === null) return null;
  const v = readPath(raw, path);
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

export function mapOfficialQuota(
  raw: unknown,
  paths: OfficialFieldPaths,
  atIso: string,
): OfficialQuotaSample | null {
  const s: OfficialQuotaSample = {
    at: atIso,
    blockPct: pctAt(raw, paths.blockPct),
    blockResetsAt: timeAt(raw, paths.blockResetsAt),
    weekPct: pctAt(raw, paths.weekPct),
    weekResetsAt: timeAt(raw, paths.weekResetsAt),
  };
  return s.blockPct === null && s.weekPct === null && s.blockResetsAt === null && s.weekResetsAt === null
    ? null
    : s;
}
