import type { Source } from '@orc/core';
import { errorMessage, useRecapSpend, useRunRecap, useSessionRecap } from '@/api/queries/work.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatUsd } from '../limits/format.ts';

export function RecapPanel({ source, id }: { source: Source; id: string }) {
  const q = useSessionRecap(source, id);
  const run = useRunRecap(source, id);
  const spend = useRecapSpend();
  const recap = q.data;

  return (
    <section aria-label="Recap" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Recap</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {spend.data ? (
            <span>{`${formatUsd(spend.data.spentUsd)} of ${formatUsd(spend.data.budgetUsd)} this month`}</span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending}
            onClick={() => run.mutate({ onDemand: true })}
          >
            {run.isPending ? 'Recapping…' : 'Recap now'}
          </Button>
        </div>
      </header>
      {recap ? (
        <>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
            {recap.text}
          </pre>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{`${recap.model} · ${formatUsd(recap.costUsd)} · ${recap.createdAt.slice(0, 16).replace('T', ' ')} UTC`}</span>
            <Badge variant="outline">{recap.engine}</Badge>
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No recap yet.</p>
      )}
      {run.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(run.error)}
        </p>
      ) : null}
    </section>
  );
}
