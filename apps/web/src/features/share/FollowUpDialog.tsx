import type { LinearIssue } from '@orc/api-contract';
import { useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';
import { type Confirmation, errorText, readConfirmation } from './ShareDialog.tsx';

export function FollowUpDialog({
  sessionPk,
  defaultTitle,
  onClose,
}: {
  sessionPk: string;
  defaultTitle: string;
  onClose(): void;
}) {
  const id = useId();
  const [title, setTitle] = useState(defaultTitle);
  const [teamKey, setTeamKey] = useState('');
  const [description, setDescription] = useState('');
  const [includeRecap, setIncludeRecap] = useState(true);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [created, setCreated] = useState<LinearIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(confirm: boolean) {
    setError(null);
    setBusy(true);
    const key = teamKey.trim();
    try {
      setCreated(
        await getApiClient().linearFollowUp({
          sessionPk,
          title: title.trim(),
          description,
          teamKey: key === '' ? undefined : key.toUpperCase(),
          includeRecap,
          confirm,
        }),
      );
    } catch (e) {
      const c = readConfirmation(e);
      if (c && !confirm) setConfirmation(c);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <GitDialog title="Create follow-up ticket" onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        {created ? (
          <p>
            Created{' '}
            <a href={created.url} target="_blank" rel="noreferrer" className="text-primary underline">
              {created.identifier}
            </a>
          </p>
        ) : confirmation ? (
          <div className="flex flex-col gap-2">
            <p className="font-medium">{confirmation.summary}</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted p-2 text-xs">
              {confirmation.preview}
            </pre>
            <Button className="self-start" onClick={() => run(true)} disabled={busy}>
              Confirm and create
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="flex flex-col gap-1">
              <label htmlFor={`${id}-title`}>Title</label>
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
            </span>
            <span className="flex flex-col gap-1">
              <label htmlFor={`${id}-team`}>Team key (optional)</label>
              <Input
                id={`${id}-team`}
                value={teamKey}
                onChange={(e) => setTeamKey(e.target.value)}
                placeholder="SAF"
              />
            </span>
            <span className="flex flex-col gap-1">
              <label htmlFor={`${id}-description`}>Description</label>
              <textarea
                id={`${id}-description`}
                className="rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </span>
            <span className="flex items-center gap-2">
              <Checkbox id={`${id}-recap`} checked={includeRecap} onCheckedChange={setIncludeRecap} />
              <label htmlFor={`${id}-recap`}>Include a session recap as context</label>
            </span>
            <Button
              className="self-start"
              onClick={() => run(false)}
              disabled={busy || title.trim().length < 3}
            >
              Preview
            </Button>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </GitDialog>
  );
}
