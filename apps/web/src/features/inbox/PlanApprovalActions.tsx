import type { InboxItem, Source } from '@orc/core';
import { Check, Info, TriangleAlert, X } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';

const INVALIDATE = [['inbox']] as const;

export function splitPk(pk: string): { source: Source; id: string } {
  const i = pk.indexOf(':');
  return { source: pk.slice(0, i) as Source, id: pk.slice(i + 1) };
}

export function PlanApprovalActions({ item }: { item: InboxItem }) {
  const [feedback, setFeedback] = useState('');
  const feedbackId = useId();
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
    <div className="flex w-full flex-col gap-3 text-sm">
      <pre className="max-h-56 overflow-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {plan}
      </pre>
      {!owned && (
        <Alert>
          <Info />
          <AlertDescription>Resume this session in the app to answer the plan.</AlertDescription>
        </Alert>
      )}
      {owned && (
        <>
          <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor={feedbackId}>Feedback for the agent</Label>
              <Textarea
                id={feedbackId}
                placeholder="Required to reject — say what to change"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={approve.busy} onClick={() => void approve.run(null)}>
                <Check />
                Approve plan
              </Button>
              <Button
                variant="outline"
                disabled={feedback.trim() === '' || reject.busy}
                onClick={() => void reject.run(feedback.trim())}
              >
                <X />
                Reject plan
              </Button>
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
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
