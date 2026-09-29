import type { Session } from '@orc/core';
import { useId, useState } from 'react';
import { useAgncEvents, useAgncMessages, useAgncPrompt } from '@/api/queries/agnc.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';
import { formatDateTime } from '@/lib/format.ts';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The body of a remote AGNC session's detail page, in place of the transcript timeline (there is
 * no local transcript). The composer is the only write path into AGNC; the daemon asks for
 * confirmation (409) before a prompt leaves this Mac, and this panel shows that confirmation.
 */
export function AgncSessionPanel({ session }: { session: Session }) {
  const messages = useAgncMessages(session.id);
  const events = useAgncEvents(session.id);
  const [text, setText] = useState('');
  const prompt = useAgncPrompt(session.id, { onSuccess: () => setText('') });
  const promptId = useId();
  const loadError = messages.error ?? events.error;
  const eventItems = events.data?.items ?? [];

  return (
    <section aria-label="AGNC session" className="flex min-h-0 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">remote</Badge>
        <span className="text-muted-foreground">
          This session runs in AGNC. Prompts are sent through the AGNC API, never a local terminal.
        </span>
      </div>

      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load the AGNC session: {errorText(loadError)}
        </p>
      ) : null}
      {messages.isLoading ? <p className="text-sm text-muted-foreground">Loading messages…</p> : null}
      {messages.data && messages.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label="Messages">
        {(messages.data ?? []).map((m) => (
          <li key={m.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{m.role}</span>
              {m.status ? <span>{m.status}</span> : null}
              {m.createdAt ? <span>{formatDateTime(m.createdAt)}</span> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">{m.text}</p>
          </li>
        ))}
      </ul>

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm">Events ({eventItems.length})</summary>
        <ul className="flex flex-col gap-1 pt-2 text-xs">
          {eventItems.map((e) => (
            <li key={e.id} className="break-words">
              <span className="text-muted-foreground">{e.type}</span> {e.text}
            </li>
          ))}
        </ul>
      </details>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (value) void prompt.run({ prompt: value });
        }}
      >
        <label className="text-sm font-medium" htmlFor={promptId}>
          Prompt
        </label>
        <Textarea id={promptId} className="min-h-20" value={text} onChange={(e) => setText(e.target.value)} />
        <div>
          <Button type="submit" size="sm" disabled={prompt.busy || !text.trim()}>
            Send to AGNC
          </Button>
        </div>
        {prompt.error ? (
          <p role="alert" className="text-xs text-destructive">
            {errorText(prompt.error)}
          </p>
        ) : null}
      </form>

      {prompt.pending ? (
        <GitDialog title="Send to AGNC?" description={prompt.pending.summary} onClose={prompt.cancel}>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
            {typeof prompt.pending.details.prompt === 'string'
              ? prompt.pending.details.prompt
              : prompt.pending.vars.prompt}
          </pre>
          <p className="text-xs text-muted-foreground">Secrets are redacted before the prompt is sent.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={prompt.cancel} disabled={prompt.busy}>
              Cancel
            </Button>
            <Button disabled={prompt.busy} onClick={() => void prompt.confirm()}>
              Send
            </Button>
          </div>
        </GitDialog>
      ) : null}
    </section>
  );
}
