import type { ReviewSummary } from '@orc/core';
import { Badge } from '@/components/ui/badge.tsx';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';

export function SummaryCard({ summary: s }: { summary: ReviewSummary }) {
  const t = s.lastTest;
  return (
    <section aria-label="Review summary" className="rounded-xl border bg-card text-sm text-card-foreground">
      <CardHeader className="p-2">
        <CardTitle className="text-sm">Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-2 pt-0 text-sm">
        <div className="flex flex-wrap items-center gap-1">
          {s.worktree && <span className="font-mono text-xs">{s.worktree.branch}</span>}
          {s.worktree?.ticket && <Badge variant="secondary">{s.worktree.ticket}</Badge>}
          <Badge variant={s.owned ? 'default' : 'outline'}>{s.owned ? 'owned' : 'observed'}</Badge>
        </div>
        <p>{`${s.files.length} ${s.files.length === 1 ? 'file' : 'files'} · +${s.additions} −${s.deletions}`}</p>
        <p className={t && t.failed > 0 ? 'text-destructive' : ''}>
          {t ? `Tests: ${t.passed} passed, ${t.failed} failed` : 'Tests: not run'}
        </p>
        <p className="whitespace-pre-wrap text-muted-foreground">{s.recap ?? 'No recap yet'}</p>
        <p>
          {s.pr
            ? `PR #${s.pr.pr.number} · ${s.pr.state} · checks ${s.pr.checks} · review ${s.pr.review.replace('_', ' ')}`
            : 'No PR yet'}
        </p>
      </CardContent>
    </section>
  );
}
