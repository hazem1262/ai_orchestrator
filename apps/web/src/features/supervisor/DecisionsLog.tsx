import type { SupervisorDecisionView } from '@orc/api-contract';
import { useMarkDecisionWrong, useSupervisorDecisions } from '@/api/queries/supervisor.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatCost, formatDateTime } from '@/lib/format.ts';

function verdict(d: SupervisorDecisionView): { label: string; variant: BadgeVariant } {
  if (d.decision === 'escalate') return { label: 'escalated', variant: 'outline' };
  return d.sent ? { label: 'answered', variant: 'success' } : { label: 'dry run', variant: 'secondary' };
}

export function DecisionsLog({ sessionPk, limit = 50 }: { sessionPk?: string; limit?: number }) {
  const { data: decisions = [], isLoading, error } = useSupervisorDecisions(sessionPk);
  const markWrong = useMarkDecisionWrong(sessionPk);
  const rows = decisions.slice(0, limit);

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Supervisor decisions">
      <h3 className="text-sm font-semibold">Decisions</h3>
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {error ? <p className="text-sm text-destructive">Could not load decisions: {error.message}</p> : null}
      {!isLoading && !error && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions yet.</p>
      ) : null}
      {markWrong.data ? (
        <p className="text-xs text-muted-foreground">
          Thanks — added a deny rule, so this question escalates from now on.
        </p>
      ) : null}
      {markWrong.error ? <p className="text-xs text-destructive">{markWrong.error.message}</p> : null}
      <ul className="flex flex-col gap-2">
        {rows.map((d) => {
          const v = verdict(d);
          return (
            <li key={d.id} className="flex min-w-0 flex-col gap-1 rounded border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={v.variant}>{`${v.label} · ${Math.round(d.confidence * 100)}%`}</Badge>
                <span className="text-xs text-muted-foreground">{formatDateTime(d.ts)}</span>
                <span className="break-all text-xs text-muted-foreground">{d.sessionPk}</span>
                <span className="text-xs text-muted-foreground">{formatCost(d.costUsd)}</span>
                {d.feedback === 'wrong' ? <Badge variant="destructive">marked wrong</Badge> : null}
                {d.sent ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => markWrong.mutate(d.id)}
                    disabled={d.feedback === 'wrong' || markWrong.isPending}
                  >
                    That was wrong
                  </Button>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-xs">{d.question}</p>
              <p className="break-words text-xs text-muted-foreground">
                {d.answer ? `→ ${d.answer} · ` : ''}
                {d.reason}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
