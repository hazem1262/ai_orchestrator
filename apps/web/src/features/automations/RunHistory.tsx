import type { AutomationRunDetail, AutomationWithStats } from '@orc/api-contract';
import { GitPullRequest, RotateCw, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { automationKeys, useAutomationRuns, useRunAction, useRunLog } from '@/api/queries/automations.ts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { formatCost, formatDateTime } from '@/lib/format.ts';

const STATUS_VARIANT: Record<AutomationRunDetail['status'], BadgeVariant> = {
  queued: 'outline',
  running: 'default',
  awaiting_approval: 'secondary',
  success: 'success',
  failed: 'destructive',
  denied: 'warning',
  over_budget: 'warning',
};

const LIVE: ReadonlySet<AutomationRunDetail['status']> = new Set(['queued', 'running', 'awaiting_approval']);

/**
 * Plan approval goes through the daemon's `409 confirmation_required` flow and its dialog. A
 * `confirm` callback replaces that dialog: it is asked first, and a yes sends `confirm: true`.
 */
export function RunHistory({
  automation,
  confirm,
}: {
  automation: AutomationWithStats;
  confirm?: (message: string) => boolean;
}) {
  const { data: runs = [], isLoading, error } = useAutomationRuns(automation.id);
  const action = useRunAction(automation.id);
  const approve = useConfirmedMutation(
    (runId: string, ok: boolean) =>
      ok ? getApiClient().automationsApprove(runId) : getApiClient().automationsApprove(runId, false),
    { invalidate: [automationKeys.runs(automation.id), automationKeys.list] },
  );
  const [logRun, setLogRun] = useState<string | null>(null);
  const logTarget = runs.find((r) => r.id === logRun) ?? null;
  const log = useRunLog(logRun, logTarget !== null && LIVE.has(logTarget.status));
  const deduped = action.data !== undefined && 'deduped' in action.data;
  const failure = error ?? action.error ?? approve.error ?? log.error;
  const plan = typeof approve.pending?.details.plan === 'string' ? approve.pending.details.plan : '';

  const onApprove = (r: AutomationRunDetail) => {
    if (!confirm) {
      void approve.run(r.id);
      return;
    }
    const message = `Approve the plan for "${automation.name}"? It cannot merge, deploy or touch production.\n\n${r.summary ?? ''}`;
    if (confirm(message)) void approve.runConfirmed(r.id);
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={`Runs of ${automation.name}`}>
      <h2 className="text-base font-semibold">Run history · {automation.name}</h2>
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {!isLoading && runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      ) : null}
      {deduped ? <p className="text-sm text-muted-foreground">That run is already queued.</p> : null}
      {runs.length > 0 ? (
        <Table className="min-w-[36rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id} className="align-top">
                <TableCell className="whitespace-nowrap">{formatDateTime(r.startedAt)}</TableCell>
                <TableCell>{r.triggerSource}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[r.status]}>{r.status.replace('_', ' ')}</Badge>
                </TableCell>
                <TableCell>{formatCost(r.costUsd)}</TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  {r.prUrl ? (
                    <a
                      className="inline-flex items-center gap-1 underline"
                      href={r.prUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <GitPullRequest className="size-3.5" aria-hidden />
                      PR
                    </a>
                  ) : null}
                  {r.diffStat ? (
                    <span className="ml-2 text-xs">
                      {r.diffStat.files} files +{r.diffStat.insertions} −{r.diffStat.deletions}
                    </span>
                  ) : null}
                  {r.summary ? (
                    <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                      {r.summary}
                    </p>
                  ) : null}
                  {r.error && r.error !== r.summary ? (
                    <p className="text-xs text-destructive">{r.error}</p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1">
                    {r.status === 'awaiting_approval' ? (
                      <>
                        <Button size="sm" disabled={approve.busy} onClick={() => onApprove(r)}>
                          Approve plan
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={action.isPending}
                          onClick={() => action.mutate({ runId: r.id, action: 'reject' })}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ runId: r.id, action: 'rerun' })}
                    >
                      <RotateCw className="size-3.5" aria-hidden />
                      Rerun
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={logRun === r.id}
                      onClick={() => setLogRun(logRun === r.id ? null : r.id)}
                    >
                      <ScrollText className="size-3.5" aria-hidden />
                      Log
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {logRun ? (
        <pre
          role="log"
          aria-label="Run log"
          className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
        >
          {log.isLoading ? 'Loading…' : (log.data?.lines ?? []).join('\n') || 'No output yet.'}
        </pre>
      ) : null}
      <AlertDialog
        open={approve.pending !== null}
        onOpenChange={(open) => {
          if (!open) approve.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve plan?</AlertDialogTitle>
            <AlertDialogDescription>{approve.pending?.summary}</AlertDialogDescription>
          </AlertDialogHeader>
          {plan ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
              {plan}
            </pre>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={approve.busy}
              onClick={(e) => {
                e.preventDefault();
                void approve.confirm();
              }}
            >
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
