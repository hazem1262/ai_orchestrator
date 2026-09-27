import type { AutomationRunDetail, AutomationWithStats } from '@orc/api-contract';
import { useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { automationKeys, useAutomationRuns, useRunAction, useRunLog } from '@/api/queries/automations.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { formatCost, formatDateTime } from '@/lib/format.ts';
import { ConfirmActionDialog } from './ConfirmActionDialog.tsx';

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
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-normal">Started</th>
                <th className="pr-2 font-normal">Trigger</th>
                <th className="pr-2 font-normal">Status</th>
                <th className="pr-2 font-normal">Cost</th>
                <th className="pr-2 font-normal">Result</th>
                <th className="font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{formatDateTime(r.startedAt)}</td>
                  <td className="py-1 pr-2">{r.triggerSource}</td>
                  <td className="py-1 pr-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="py-1 pr-2">{formatCost(r.costUsd)}</td>
                  <td className="max-w-md py-1 pr-2">
                    {r.prUrl ? (
                      <a className="underline" href={r.prUrl} target="_blank" rel="noreferrer">
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
                  </td>
                  <td className="py-1">
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
                        Rerun
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={logRun === r.id}
                        onClick={() => setLogRun(logRun === r.id ? null : r.id)}
                      >
                        Log
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <ConfirmActionDialog
        request={approve.pending}
        busy={approve.busy}
        title="Approve plan?"
        confirmLabel="Approve"
        onConfirm={() => void approve.confirm()}
        onCancel={approve.cancel}
      />
    </section>
  );
}
