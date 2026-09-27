import type { Source } from '@orc/core';
import { useState } from 'react';
import { useGenerateHandoff, useLatestHandoff, useResumeFresh } from '@/api/queries/work.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';

function download(markdown: string, handoffId: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `handoff-${handoffId}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function HandoffPanel({ source, id }: { source: Source; id: string }) {
  const q = useLatestHandoff(source, id);
  const generate = useGenerateHandoff(source, id);
  const resume = useResumeFresh();
  const [confirming, setConfirming] = useState(false);
  const current = q.data;

  return (
    <section aria-label="Handoff" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Handoff</h3>
        <div className="flex items-center gap-2">
          {current ? <Badge variant="outline">{current.handoff.status}</Badge> : null}
          <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {current ? 'Regenerate' : 'Create handoff'}
          </Button>
        </div>
      </header>
      {current ? (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
            {current.markdown}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => download(current.markdown, current.handoff.id)}
            >
              Download .md
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(current.markdown)}
            >
              Copy
            </Button>
            {confirming ? (
              <>
                <Button
                  size="sm"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate(current.handoff.id, { onSuccess: () => setConfirming(false) })}
                >
                  Confirm — start a new session
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>
                Resume fresh with handoff…
              </Button>
            )}
          </div>
          {confirming ? (
            <p className="text-xs text-muted-foreground">
              This starts a new session in the original session's directory with the handoff as its first
              prompt.
            </p>
          ) : null}
          {resume.isSuccess ? (
            <p className="text-xs text-success">{`Started a new session (terminal ${resume.data.ptyId}).`}</p>
          ) : null}
          {resume.isError ? (
            <p role="alert" className="text-xs text-destructive">
              Could not start the session (check the concurrency cap).
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No handoff yet.</p>
      )}
      {generate.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not generate the handoff.
        </p>
      ) : null}
    </section>
  );
}
