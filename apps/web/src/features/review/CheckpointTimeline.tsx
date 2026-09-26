import { getApiClient } from '@/api/client.ts';
import { useCheckpoints } from '@/api/queries/review.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import type { DiffSourceSel } from './ReviewPage.tsx';

const INVALIDATE = [['checkpoints'], ['diff'], ['review']] as const;

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
  const turns = (list.data ?? []).filter((c) => c.kind !== 'safety');
  const error = rewind.error ?? save.error;
  return (
    <section aria-label="Checkpoints" className="space-y-1 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Checkpoints</h3>
        <Button size="sm" variant="ghost" onClick={() => void save.run(sessionPk)}>
          Save now
        </Button>
      </div>
      {list.isSuccess && turns.length === 0 && <p className="text-muted-foreground">No checkpoints yet.</p>}
      <ol className="space-y-1">
        {turns.map((c) => (
          <li key={c.id} className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={selected.kind === 'checkpoint' && selected.id === c.id}
              className={`flex-1 text-left ${selected.kind === 'checkpoint' && selected.id === c.id ? 'font-semibold' : ''}`}
              onClick={() => onSelect({ kind: 'checkpoint', id: c.id })}
            >
              {c.kind === 'manual' ? `Manual (turn ${c.turn})` : `Turn ${c.turn}`}
            </button>
            <time className="text-xs text-muted-foreground" dateTime={c.createdAt}>
              {new Date(c.createdAt).toLocaleTimeString()}
            </time>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rewind to turn ${c.turn}`}
              onClick={() => void rewind.run(c.id)}
            >
              ↺
            </Button>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      )}
      <GitConfirmDialog
        request={rewind.pending}
        busy={rewind.busy}
        title="Rewind files?"
        confirmLabel="Rewind"
        danger
        onConfirm={() => void rewind.confirm()}
        onCancel={rewind.cancel}
      />
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
