import type {
  AnalyticsGroupBy,
  CostRow,
  OutcomesResult,
  TimingResult,
  TokenTotals,
  ToolKind,
  ToolUsageRow,
  TopTicket,
  WstackSkillRow,
} from '../types/index.ts';

export interface AnalyticsEntry {
  sessionPk: string;
  ts: string;
  source: string;
  projectId: string | null;
  tickets: string[];
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  latencyMs: number | null;
}
export interface AnalyticsTool {
  ts: string;
  kind: ToolKind;
  name: string;
  durationMs: number | null;
}

const NO_TICKET = '(none)';
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function bucketKey(ts: string, bucket: 'day' | 'week'): string {
  const d = new Date(ts);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (bucket === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function keysFor(e: AnalyticsEntry, groupBy: AnalyticsGroupBy): Array<{ key: string; share: number }> {
  switch (groupBy) {
    case 'day':
    case 'week':
      return [{ key: bucketKey(e.ts, groupBy), share: 1 }];
    case 'project':
      return [{ key: e.projectId ?? 'unassigned', share: 1 }];
    case 'model':
      return [{ key: e.model, share: 1 }];
    case 'source':
      return [{ key: e.source, share: 1 }];
    case 'ticket':
      return e.tickets.length === 0
        ? [{ key: NO_TICKET, share: 1 }]
        : e.tickets.map((t) => ({ key: t, share: 1 / e.tickets.length }));
  }
}

export function groupCost(entries: AnalyticsEntry[], groupBy: AnalyticsGroupBy): CostRow[] {
  const acc = new Map<string, { costUsd: number; tokens: TokenTotals; pks: Set<string> }>();
  for (const e of entries) {
    for (const { key, share } of keysFor(e, groupBy)) {
      let a = acc.get(key);
      if (!a) {
        a = { costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pks: new Set() };
        acc.set(key, a);
      }
      a.costUsd += e.costUsd * share;
      a.tokens.input += e.input * share;
      a.tokens.output += e.output * share;
      a.tokens.cacheRead += e.cacheRead * share;
      a.tokens.cacheWrite += e.cacheWrite * share;
      a.pks.add(e.sessionPk);
    }
  }
  const rows: CostRow[] = [...acc.entries()].map(([key, a]) => ({
    key,
    costUsd: round(a.costUsd),
    tokens: {
      input: Math.round(a.tokens.input),
      output: Math.round(a.tokens.output),
      cacheRead: Math.round(a.tokens.cacheRead),
      cacheWrite: Math.round(a.tokens.cacheWrite),
    },
    sessions: a.pks.size,
  }));
  return groupBy === 'day' || groupBy === 'week'
    ? rows.sort((x, y) => x.key.localeCompare(y.key))
    : rows.sort((x, y) => y.costUsd - x.costUsd || x.key.localeCompare(y.key));
}

export function topSessionCosts(
  entries: AnalyticsEntry[],
  limit: number,
): Array<{ pk: string; costUsd: number }> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.sessionPk, (m.get(e.sessionPk) ?? 0) + e.costUsd);
  return [...m.entries()]
    .map(([pk, costUsd]) => ({ pk, costUsd: round(costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, limit);
}

export function topTickets(entries: AnalyticsEntry[], limit: number): TopTicket[] {
  return groupCost(
    entries.filter((e) => e.tickets.length > 0),
    'ticket',
  )
    .slice(0, limit)
    .map((r) => ({ ticket: r.key, costUsd: r.costUsd, sessions: r.sessions }));
}

export function costPerMergedPr(
  entries: AnalyticsEntry[],
  mergedPrSessions: string[][],
): { mergedPrs: number; costPerMergedPrUsd: number | null } {
  if (mergedPrSessions.length === 0) return { mergedPrs: 0, costPerMergedPrUsd: null };
  const pks = new Set(mergedPrSessions.flat());
  const total = entries.filter((e) => pks.has(e.sessionPk)).reduce((a, e) => a + e.costUsd, 0);
  return { mergedPrs: mergedPrSessions.length, costPerMergedPrUsd: round(total / mergedPrSessions.length) };
}

export function toolUsageRows(tools: AnalyticsTool[], bucket: 'day' | 'week'): ToolUsageRow[] {
  const m = new Map<string, ToolUsageRow>();
  for (const t of tools) {
    const b = bucketKey(t.ts, bucket);
    const k = `${b}|${t.kind}|${t.name}`;
    const row = m.get(k) ?? { bucket: b, kind: t.kind, name: t.name, count: 0 };
    row.count += 1;
    m.set(k, row);
  }
  return [...m.values()].sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || b.count - a.count || a.name.localeCompare(b.name),
  );
}

export function timingSummary(
  entries: AnalyticsEntry[],
  tools: AnalyticsTool[],
  bucket: 'day' | 'week',
): TimingResult {
  const modelMs = entries.reduce((a, e) => a + (e.latencyMs ?? 0), 0);
  const toolMs = tools.reduce((a, t) => a + (t.durationMs ?? 0), 0);
  const per = new Map<string, { read: number; total: number }>();
  for (const e of entries) {
    const b = bucketKey(e.ts, bucket);
    const p = per.get(b) ?? { read: 0, total: 0 };
    p.read += e.cacheRead;
    p.total += e.input + e.cacheRead + e.cacheWrite;
    per.set(b, p);
  }
  return {
    modelMs,
    toolMs,
    modelShare: modelMs + toolMs > 0 ? modelMs / (modelMs + toolMs) : null,
    cacheHitTrend: [...per.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([b, p]) => ({ bucket: b, rate: p.total > 0 ? p.read / p.total : null })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function addCounts(into: Record<string, number>, from: unknown): void {
  if (!isObj(from)) return;
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
}

export function summarizeFacets(facets: unknown[], sessionIds: ReadonlySet<string> | null): OutcomesResult {
  const out: OutcomesResult = { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} };
  for (const f of facets) {
    if (!isObj(f) || typeof f.session_id !== 'string') continue;
    if (sessionIds !== null && !sessionIds.has(f.session_id)) continue;
    out.sessions += 1;
    if (typeof f.outcome === 'string') out.outcomes[f.outcome] = (out.outcomes[f.outcome] ?? 0) + 1;
    addCounts(out.friction, f.friction_counts);
    addCounts(out.goalCategories, f.goal_categories);
  }
  return out;
}

function toIso(ts: unknown): string | null {
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return null;
}

export function summarizeWstackTimeline(lines: unknown[], from: string, to: string): WstackSkillRow[] {
  const m = new Map<string, { runs: number; outcomes: Record<string, number>; dur: number; durN: number }>();
  for (const l of lines) {
    if (!isObj(l) || typeof l.skill !== 'string' || typeof l.outcome !== 'string') continue;
    const ts = toIso(l.ts);
    if (ts === null || ts < from || ts > to) continue;
    const a = m.get(l.skill) ?? { runs: 0, outcomes: {}, dur: 0, durN: 0 };
    a.runs += 1;
    a.outcomes[l.outcome] = (a.outcomes[l.outcome] ?? 0) + 1;
    if (typeof l.duration_s === 'number') {
      a.dur += l.duration_s;
      a.durN += 1;
    }
    m.set(l.skill, a);
  }
  return [...m.entries()]
    .map(([skill, a]) => ({
      skill,
      runs: a.runs,
      outcomes: a.outcomes,
      avgDurationS: a.durN > 0 ? a.dur / a.durN : null,
    }))
    .sort((x, y) => y.runs - x.runs || x.skill.localeCompare(y.skill));
}
