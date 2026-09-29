import type { CheckpointRecord } from '@orc/core';
import { History, Plus, RotateCcw } from 'lucide-react';
import { getApiClient } from '@/api/client.ts';
import { useCheckpoints } from '@/api/queries/review.ts';
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
import { Button } from '@/components/ui/button.tsx';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import type { DiffSourceSel } from './ReviewPage.tsx';

const INVALIDATE = [['checkpoints'], ['diff'], ['review']] as const;

function checkpointLabel(c: CheckpointRecord): string {
  if (c.kind === 'manual') return `Manual (turn ${c.turn})`;
  if (c.kind === 'safety') return `Safety (turn ${c.turn})`;
  return `Turn ${c.turn}`;
}

export function CheckpointTimeline({
  sessionPk,
  selected,
  onSelect,
}: {
  sessionPk: string;
  selected: DiffSourceSel;
  onSelect(s: DiffSourceSel): void;
}) {
  const list = useCheckpoints(sessionPk);
  const rewind = useConfirmedMutation(
    (id: string, confirm: boolean) => getApiClient().checkpointsRewind(id, { confirm }),
    { invalidate: INVALIDATE },
  );
  const save = useConfirmedMutation(
    (pk: string, confirm: boolean) => getApiClient().checkpointsCreate({ sessionPk: pk, confirm }),
    { invalidate: INVALIDATE },
  );
  const turns = list.data ?? [];
  const error = rewind.error ?? save.error;
  return (
    <section aria-label="Checkpoints" className="rounded-xl border bg-card text-sm text-card-foreground">
      <CardHeader className="p-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          Checkpoints
          <Button size="sm" variant="ghost" onClick={() => void save.run(sessionPk)}>
            <Plus aria-hidden />
            Save now
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-2 pt-0">
        {list.isSuccess && turns.length === 0 && <p className="text-muted-foreground">No checkpoints yet.</p>}
        <ol className="space-y-1">
          {turns.map((c) => (
            <li key={c.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-pressed={selected.kind === 'checkpoint' && selected.id === c.id}
                className={`flex flex-1 items-center gap-1.5 text-left ${selected.kind === 'checkpoint' && selected.id === c.id ? 'font-semibold' : ''}`}
                onClick={() => onSelect({ kind: 'checkpoint', id: c.id })}
              >
                <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                {checkpointLabel(c)}
              </button>
              <time className="text-xs text-muted-foreground" dateTime={c.createdAt}>
                {new Date(c.createdAt).toLocaleTimeString()}
              </time>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Rewind to turn ${c.turn}`}
                onClick={() => void rewind.run(c.id)}
              >
                <RotateCcw aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
        {error && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
      </CardContent>
      <AlertDialog open={rewind.pending !== null} onOpenChange={(o) => !o && rewind.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rewind files?</AlertDialogTitle>
            <AlertDialogDescription>{rewind.pending?.summary}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rewind.busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={rewind.busy}
              onClick={() => void rewind.confirm()}
            >
              Rewind
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <GitConfirmDialog
        request={save.pending}
        busy={save.busy}
        title="Save checkpoint?"
        confirmLabel="Save"
        onConfirm={() => void save.confirm()}
        onCancel={save.cancel}
      />
    </section>
  );
}
