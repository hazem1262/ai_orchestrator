import { useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { GitDialog } from './GitDialog.tsx';
import type { ConfirmRequest } from './useConfirmedMutation.ts';

interface Props<V> {
  request: ConfirmRequest<V> | null;
  busy: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (patch?: Partial<V>) => void;
  onCancel: () => void;
}

export function GitConfirmDialog<V>({
  request,
  busy,
  title,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: Props<V>) {
  const ackId = useId();
  const [ack, setAck] = useState(false);
  // A new request resets the acknowledgement during render, so a tick made in the first frame
  // the dialog is shown is never undone by a later effect.
  const [ackFor, setAckFor] = useState(request);
  if (request !== ackFor) {
    setAckFor(request);
    setAck(false);
  }
  if (!request) return null;
  const external = request.details.external === true;
  const files = Array.isArray(request.details.files) ? (request.details.files as string[]) : [];
  const mainDirty = Array.isArray(request.details.mainDirty) ? (request.details.mainDirty as string[]) : [];
  return (
    <GitDialog title={title} description={request.summary} onClose={onCancel}>
      {files.length > 0 && (
        <ul className="max-h-48 overflow-auto font-mono text-xs" aria-label="Files">
          {files.map((f) => (
            <li key={f} className={mainDirty.includes(f) ? 'text-destructive' : ''}>
              {f}
            </li>
          ))}
        </ul>
      )}
      {external && (
        <div className="flex items-center gap-2 text-sm">
          <Checkbox id={ackId} checked={ack} onCheckedChange={setAck} />
          <label htmlFor={ackId}>I understand this worktree was created outside the app</label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={danger ? 'destructive' : 'default'}
          disabled={busy || (external && !ack)}
          onClick={() =>
            onConfirm(external ? ({ confirmExternal: true } as unknown as Partial<V>) : undefined)
          }
        >
          {confirmLabel}
        </Button>
      </div>
    </GitDialog>
  );
}
