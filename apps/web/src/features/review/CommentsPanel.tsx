import type { ReviewComment, Source } from '@orc/core';
import { ClipboardCopy, Plus, Send, X } from 'lucide-react';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
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
    <section aria-label="Review comments" className="rounded-xl border bg-card text-sm text-card-foreground">
      <CardHeader className="p-2">
        <CardTitle className="text-sm">Comments ({p.draft.comments.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-2 pt-0">
        <ul className="space-y-1">
          {p.draft.comments.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: draft comments have no id and are removed by position
            <li key={`${c.file}:${c.line}:${i}`} className="rounded-md border px-2 py-1.5">
              <div className="flex justify-between gap-1 font-mono text-xs text-muted-foreground">
                <span className="truncate">{`${c.file}:${c.line}`}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove comment ${i + 1}`}
                  onClick={() => p.draft.remove(i)}
                >
                  <X aria-hidden />
                </Button>
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ul>
        {p.draft.comments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {p.owned && (
              <Button size="sm" disabled={send.busy} onClick={() => void send.run(p.draft.comments)}>
                <Send aria-hidden />
                Send to agent
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              <ClipboardCopy aria-hidden />
              Copy prompt
            </Button>
            <Button size="sm" variant="outline" onClick={() => void newSession()}>
              <Plus aria-hidden />
              New session with feedback
            </Button>
          </div>
        )}
        {send.error && (
          <p role="alert" className="text-destructive">
            {send.error.message}
          </p>
        )}
      </CardContent>
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
