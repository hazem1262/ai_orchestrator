import type { BudgetStatus, CostRow, TopTicket, UsageSnapshot } from '../types/index.ts';

export interface WeeklyDigestInput {
  weekStart: string;
  weekEnd: string;
  spendUsd: number;
  estimated: boolean;
  spendByProject: CostRow[];
  shippedPrs: Array<{ title: string; url: string; number: number; mergedAt: string; tickets: string[] }>;
  stuckSessions: Array<{ pk: string; name: string | null; status: string; since: string }>;
  topTickets: TopTicket[];
  quota: UsageSnapshot;
  budgets: BudgetStatus[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const list = (items: string[]) => (items.length > 0 ? items : ['- none']).join('\n');

export function renderWeeklyDigest(i: WeeklyDigestInput): string {
  const q = i.quota;
  const label = q.source === 'estimate' ? 'estimated' : 'official';
  const weekPct = q.week.pctOfLimit !== null ? `, ${pct(q.week.pctOfLimit)} of limit` : '';
  return [
    `# Weekly digest — ${i.weekStart} → ${i.weekEnd}`,
    '',
    '## Spend',
    `- Total: ${usd(i.spendUsd)}${i.estimated ? ' (estimated)' : ''}`,
    list(i.spendByProject.map((r) => `- ${r.key}: ${usd(r.costUsd)} (${r.sessions} sessions)`)),
    '',
    `## Shipped PRs (${i.shippedPrs.length})`,
    list(
      i.shippedPrs.map(
        (p) =>
          `- [#${p.number} ${p.title}](${p.url})${p.tickets.length ? ` — ${p.tickets.join(', ')}` : ''} — merged ${p.mergedAt.slice(0, 10)}`,
      ),
    ),
    '',
    `## Stuck sessions (${i.stuckSessions.length})`,
    list(i.stuckSessions.map((s) => `- ${s.name ?? s.pk} — ${s.status} since ${utc(s.since)}`)),
    '',
    '## Top tickets',
    list(i.topTickets.map((t) => `- ${t.ticket} — ${usd(t.costUsd)} (${t.sessions} sessions)`)),
    '',
    '## Quota & budgets',
    `- 7 days: ${q.week.tokens.toLocaleString('en-US')} tokens, ${usd(q.week.costUsd)}${weekPct} (${label})`,
    list(
      i.budgets.map(
        (b) =>
          `- ${b.budget.scopeType}${b.budget.scopeId ? ` ${b.budget.scopeId}` : ''} ${b.budget.period}: ${usd(b.spentUsd)} of ${usd(b.budget.limitUsd)} (${pct(b.pct)})`,
      ),
    ),
    '',
  ].join('\n');
}
