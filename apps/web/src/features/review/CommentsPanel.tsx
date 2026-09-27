import type { ReviewComment, Source } from '@orc/core';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import type { ReviewDraft } from './useReviewDraft.ts';

export function CommentsPanel(p: {
  source: Source;
  id: string;
  cwd: string;
  projectId: string | null;
  owned: boolean;
  draft: ReviewDraft;
}) {
  const openTerminal = useTerminalStore((s) => s.open);
  const send = useConfirmedMutation(
    (comments: ReviewComment[], confirm: boolean) =>
      getApiClient().reviewComments(p.source, p.id, { comments, deliver: 'session', confirm }),
    {
      onSuccess: (r) => {
        if (r.sent) p.draft.clearComments();
      },
    },
  );
  const asText = () =>
    getApiClient().reviewComments(p.source, p.id, {
      comments: p.draft.comments,
      deliver: 'text',
      confirm: false,
    });

  const copy = async () => {
    const { text } = await asText();
    await navigator.clipboard.writeText(text);
  };
  const newSession = async () => {
    const { text } = await asText();
    const r = await getApiClient().sessionsLaunch({
      source: 'claude',
      projectId: p.projectId,
      cwd: p.cwd,
      prompt: text,
      vars: {},
      planApproval: false,
    });
    if ('ptyId' in r) openTerminal(r.ptyId, 'review follow-up');
    p.draft.clearComments();
  };

  return (
    <section aria-label="Review comments" className="space-y-2 text-sm">
      <h3 className="font-semibold">Comments ({p.draft.comments.length})</h3>
      <ul className="space-y-1">
        {p.draft.comments.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: draft comments have no id and are removed by position
          <li key={`${c.file}:${c.line}:${i}`} className="rounded border p-1">
            <div className="flex justify-between font-mono text-xs">
              <span>{`${c.file}:${c.line}`}</span>
              <button type="button" aria-label={`Remove comment ${i + 1}`} onClick={() => p.draft.remove(i)}>
                ×
              </button>
            </div>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      {p.draft.comments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {p.owned && (
            <Button size="sm" disabled={send.busy} onClick={() => void send.run(p.draft.comments)}>
              Send to agent
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            Copy prompt
          </Button>
          <Button size="sm" variant="outline" onClick={() => void newSession()}>
            New session with feedback
          </Button>
        </div>
      )}
      {send.error && (
        <p role="alert" className="text-destructive">
          {send.error.message}
        </p>
      )}
      <GitConfirmDialog
        request={send.pending}
        busy={send.busy}
        title="Send review to the agent?"
        confirmLabel="Send"
        onConfirm={() => void send.confirm()}
        onCancel={send.cancel}
      />
    </section>
  );
}
