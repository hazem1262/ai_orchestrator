import { isApiErrorWithCode, type ShareSource } from '@orc/api-contract';
import { useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';

export type ShareTarget =
  | { kind: 'linear-comment'; identifier?: string }
  | { kind: 'slack-post'; channel?: string };

type Phase = 'edit' | 'preview' | 'sending' | 'done';

export interface Confirmation {
  summary: string;
  preview: string;
}

/** The `summary` and `preview` a `confirmation_required` error carries, or null for any other error. */
export function readConfirmation(e: unknown): Confirmation | null {
  if (!isApiErrorWithCode(e, 'confirmation_required')) return null;
  const d = (e.details ?? {}) as { summary?: unknown; preview?: unknown };
  return {
    summary: typeof d.summary === 'string' ? d.summary : '',
    preview: typeof d.preview === 'string' ? d.preview : '',
  };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Preview first: the route answers `confirmation_required` with the exact text it would post.
 * Confirming re-sends that previewed text, so what is posted is what was shown.
 */
export function ShareDialog({
  title,
  target,
  source,
  onClose,
}: {
  title: string;
  target: ShareTarget;
  source: ShareSource;
  onClose(): void;
}) {
  const id = useId();
  const [identifier, setIdentifier] = useState(
    target.kind === 'linear-comment' ? (target.identifier ?? '') : '',
  );
  const [channel, setChannel] = useState(target.kind === 'slack-post' ? (target.channel ?? '') : '');
  const [phase, setPhase] = useState<Phase>('edit');
  const [confirmation, setConfirmation] = useState<Confirmation>({ summary: '', preview: '' });
  const [error, setError] = useState<string | null>(null);

  const send = (src: ShareSource, confirm: boolean) => {
    const api = getApiClient();
    if (target.kind === 'linear-comment')
      return api.linearComment(identifier.trim().toUpperCase(), src, confirm);
    const ch = channel.trim();
    return api.slackPost({ channel: ch === '' ? undefined : ch, source: src, confirm });
  };

  async function onPreview() {
    setError(null);
    try {
      await send(source, false);
      setPhase('done');
    } catch (e) {
      const c = readConfirmation(e);
      if (c) {
        setConfirmation(c);
        setPhase('preview');
      } else {
        setError(errorText(e));
      }
    }
  }

  async function onConfirm() {
    setError(null);
    setPhase('sending');
    try {
      await send({ kind: 'text', text: confirmation.preview }, true);
      setPhase('done');
    } catch (e) {
      setError(errorText(e));
      setPhase('preview');
    }
  }

  return (
    <GitDialog title={title} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        {phase === 'edit' ? (
          <div className="flex flex-col gap-2">
            {target.kind === 'linear-comment' ? (
              <span className="flex flex-col gap-1">
                <label htmlFor={`${id}-issue`}>Linear issue</label>
                <Input
                  id={`${id}-issue`}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="SAF-1787"
                />
              </span>
            ) : (
              <span className="flex flex-col gap-1">
                <label htmlFor={`${id}-channel`}>Slack channel ID (empty = daily channel)</label>
                <Input
                  id={`${id}-channel`}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="C0123ABCD"
                />
              </span>
            )}
            <Button
              className="self-start"
              onClick={onPreview}
              disabled={target.kind === 'linear-comment' && identifier.trim() === ''}
            >
              Preview
            </Button>
          </div>
        ) : null}
        {phase === 'preview' || phase === 'sending' ? (
          <div className="flex flex-col gap-2">
            <p className="font-medium">{confirmation.summary}</p>
            <pre
              data-testid="share-preview"
              className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-muted p-2 text-xs"
            >
              {confirmation.preview}
            </pre>
            <p className="text-xs text-muted-foreground">Secrets were redacted. This is posted as you.</p>
            <Button className="self-start" onClick={onConfirm} disabled={phase === 'sending'}>
              Confirm and post
            </Button>
          </div>
        ) : null}
        {phase === 'done' ? <p>Posted.</p> : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </div>
    </GitDialog>
  );
}
