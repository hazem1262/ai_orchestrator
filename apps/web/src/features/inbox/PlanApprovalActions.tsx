import type { InboxItem, Source } from '@orc/core';
import { useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';

const INVALIDATE = [['inbox']] as const;

export function splitPk(pk: string): { source: Source; id: string } {
  const i = pk.indexOf(':');
  return { source: pk.slice(0, i) as Source, id: pk.slice(i + 1) };
}

export function PlanApprovalActions({ item }: { item: InboxItem }) {
  const [feedback, setFeedback] = useState('');
  const plan = typeof item.payload.plan === 'string' ? item.payload.plan : '';
  const owned = item.payload.owned === true;
  const target = item.sessionId ? splitPk(item.sessionId) : null;
  const approve = useConfirmedMutation(
    (_: null, confirm: boolean) => {
      if (!target) throw new Error('This item has no session.');
      return getApiClient().planApprove(target.source, target.id, { confirm });
    },
    { invalidate: INVALIDATE },
  );
  const reject = useConfirmedMutation(
    (text: string, confirm: boolean) => {
      if (!target) throw new Error('This item has no session.');
      return getApiClient().planReject(target.source, target.id, { feedback: text, confirm });
    },
    { invalidate: INVALIDATE },
  );
  const error = approve.error ?? reject.error;

  return (
    <div className="flex w-full flex-col gap-2 text-sm">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{plan}</pre>
      {!owned && <p className="text-muted-foreground">Resume this session in the app to answer the plan.</p>}
      {owned && (
        <>
          <div className="flex gap-1">
            <Button size="sm" disabled={approve.busy} onClick={() => void approve.run(null)}>
              Approve plan
            </Button>
          </div>
          <textarea
            aria-label="Feedback"
            placeholder="Feedback for the agent (required to reject)"
            className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary"
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={feedback.trim() === '' || reject.busy}
              onClick={() => void reject.run(feedback.trim())}
            >
              Reject plan
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error.message}
            </p>
          )}
        </>
      )}
      <GitConfirmDialog
        request={approve.pending}
        busy={approve.busy}
        title="Approve plan?"
        confirmLabel="Approve"
        onConfirm={() => void approve.confirm()}
        onCancel={approve.cancel}
      />
      <GitConfirmDialog
        request={reject.pending}
        busy={reject.busy}
        title="Reject plan?"
        confirmLabel="Reject"
        onConfirm={() => void reject.confirm()}
        onCancel={reject.cancel}
      />
    </div>
  );
}
