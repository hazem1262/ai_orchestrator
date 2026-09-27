import { Button } from '@/components/ui/button.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';
import type { ConfirmRequest } from '@/features/git/useConfirmedMutation.ts';

/** Shows the daemon's `409 confirmation_required` summary, plus the plan when the daemon sends one. */
export function ConfirmActionDialog<V>({
  request,
  busy,
  title,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  request: ConfirmRequest<V> | null;
  busy: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!request) return null;
  const plan = typeof request.details.plan === 'string' ? request.details.plan : '';
  return (
    <GitDialog title={title} description={request.summary} onClose={onCancel}>
      {plan ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{plan}</pre>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </GitDialog>
  );
}
