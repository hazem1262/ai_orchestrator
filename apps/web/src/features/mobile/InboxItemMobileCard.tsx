import type { InboxItem } from '@orc/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getApiClient } from '@/api/client.ts';
import { upsertInboxItemInCache, useInboxAction } from '@/api/queries/inbox.ts';
import { withStepUp } from '@/api/step-up.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';

const HOUR_MS = 3_600_000;

function sessionRef(item: InboxItem): { source: string; id: string } | null {
  const { source, id } = item.payload;
  return typeof source === 'string' && typeof id === 'string' ? { source, id } : null;
}

export function InboxItemMobileCard({ item, kindLabel }: { item: InboxItem; kindLabel?: string }) {
  const qc = useQueryClient();
  const action = useInboxAction();
  const approve = useMutation({
    mutationFn: () => withStepUp(() => getApiClient().inboxApprove(item.id)),
    onSuccess: (next) => upsertInboxItemInCache(qc, next),
  });
  const busy = action.isPending || approve.isPending;
  const error = approve.error ?? action.error;
  const triageable = item.state === 'open' || item.state === 'snoozed';
  const ref = sessionRef(item);
  const label = kindLabel ?? item.kind.replace(/_/g, ' ');

  return (
    <article aria-label={`${label}: ${item.reason}`} className="flex flex-col gap-2 rounded-lg border p-3">
      <header className="flex items-center justify-between gap-2 text-sm">
        <Badge variant={item.kind === 'error' || item.kind === 'tests_red' ? 'destructive' : 'secondary'}>
          {label}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">{item.ticket ?? item.projectId ?? ''}</span>
      </header>
      <p className="text-sm">{item.reason}</p>
      <div className="flex flex-wrap items-center gap-2">
        {triageable ? (
          <>
            <Button disabled={busy} onClick={() => approve.mutate()}>
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action.mutate({
                  id: item.id,
                  action: 'snooze',
                  until: new Date(Date.now() + HOUR_MS).toISOString(),
                })
              }
            >
              Snooze 1h
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate({ id: item.id, action: 'done' })}
            >
              Done
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate({ id: item.id, action: 'reopen' })}
          >
            Reopen
          </Button>
        )}
        {ref ? (
          <Link to="/sessions/$source/$id" params={ref} className="ml-auto text-sm text-primary underline">
            Open session to reply
          </Link>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
    </article>
  );
}
