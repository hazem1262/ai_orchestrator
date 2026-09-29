import type { Session } from '@orc/core';
import { useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { performStepUp, withStepUp } from '@/api/step-up.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ReplyComposer({
  session,
  stepUp = performStepUp,
}: {
  session: Session;
  stepUp?: () => Promise<void>;
}) {
  const fieldId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owned =
    session.live?.ownership === 'owned' && session.live.ptyId !== null && session.live.status !== 'ended';

  if (!owned) {
    return (
      <p className="text-sm text-muted-foreground">
        This session is not running in the app, so replies are off. Resume it here to take over.
      </p>
    );
  }

  return (
    <form
      aria-label="Reply"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const reply = text.trim();
        if (!reply) return;
        setBusy(true);
        setError(null);
        void withStepUp(() => getApiClient().sessionsReply(session.source, session.id, reply), stepUp)
          .then(() => setText(''))
          .catch((err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={fieldId} className="text-sm font-medium">
        Reply to this session
      </label>
      <Textarea
        id={fieldId}
        className="text-base md:text-base"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="yes, continue"
      />
      <Button type="submit" className="self-end" disabled={busy || text.trim() === ''}>
        Send
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
