import type { Session } from '@orc/core';
import { useAgncHandoff, useAgncStatus } from '@/api/queries/agnc.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Session header action: creates an AGNC session whose first prompt is this session's handoff.
 * Shown only while AGNC is enabled, and never on an AGNC session. The daemon answers the first
 * request with `409 confirmation_required` (repo and title), shown here before anything is sent.
 * `confirm`, when given, is asked first and can stop the request before it goes out.
 */
export function HandoffToAgncButton({
  session,
  confirm,
}: {
  session: Session;
  confirm?: (message: string) => boolean;
}) {
  const status = useAgncStatus();
  const handoff = useAgncHandoff();
  if (session.source === 'agnc' || status.data?.enabled !== true) return null;
  const source = session.source === 'codex' ? 'codex' : 'claude';
  const title = session.name ?? session.firstPrompt ?? session.id;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={handoff.busy}
        onClick={() => {
          if (confirm && !confirm(`Hand "${title}" off to AGNC?`)) return;
          void handoff.run({ source, id: session.id });
        }}
      >
        Hand off to AGNC
      </Button>
      {handoff.data ? (
        handoff.data.url ? (
          <a href={handoff.data.url} target="_blank" rel="noopener" className="text-primary underline">
            created {handoff.data.id}
          </a>
        ) : (
          <span className="text-muted-foreground">created {handoff.data.id}</span>
        )
      ) : null}
      {handoff.error ? (
        <span role="alert" className="text-destructive">
          {errorText(handoff.error)}
        </span>
      ) : null}
      {handoff.pending ? (
        <GitDialog title="Hand off to AGNC?" description={handoff.pending.summary} onClose={handoff.cancel}>
          <p className="text-sm">
            The daemon builds this session&apos;s handoff (summary, files, next steps), redacts it and starts
            a new AGNC session with it as the first prompt. Nothing changes locally.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handoff.cancel} disabled={handoff.busy}>
              Cancel
            </Button>
            <Button disabled={handoff.busy} onClick={() => void handoff.confirm()}>
              Create AGNC session
            </Button>
          </div>
        </GitDialog>
      ) : null}
    </span>
  );
}
