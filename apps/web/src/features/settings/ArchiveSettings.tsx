import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';
import { archiveStatusKey, useArchiveStatus } from '@/api/queries/archive.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { daysAgo, formatBytes, retentionWarning } from './format.ts';

export function ArchiveSettings({ now }: { now?: () => number } = {}) {
  const clock = now ?? Date.now;
  const qc = useQueryClient();
  const { data: s } = useArchiveStatus();
  const sync = useMutation({
    mutationFn: () => getApiClient().archiveSync(),
    onSuccess: () => qc.invalidateQueries({ queryKey: archiveStatusKey }),
  });

  if (!s) {
    return (
      <section aria-label="Transcript archive" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Transcript archive</h2>
        <Skeleton className="h-24" />
      </section>
    );
  }

  const warning = retentionWarning(s);
  return (
    <section aria-label="Transcript archive" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Transcript archive</h2>
      <p className="text-sm">{`${s.files} files · ${formatBytes(s.bytes)} · ${s.codec}`}</p>
      {s.oldestTranscript ? (
        <p className="text-sm text-muted-foreground">
          {`Oldest transcript on disk: ${s.oldestTranscript.slice(0, 10)} (${daysAgo(s.oldestTranscript, clock())} days ago)`}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {`Claude cleanupPeriodDays: ${s.cleanupPeriodDays === null ? 'not set (30 days)' : s.cleanupPeriodDays}`}
      </p>
      {warning ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
          {warning}
        </p>
      ) : null}
      <p className="text-sm">
        Recommended addition to <code className="font-mono text-xs">~/.claude/settings.json</code> — the app
        never edits that file:
      </p>
      <pre className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs">
        {s.recommendedSnippet}
      </pre>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard?.writeText(s.recommendedSnippet)}
        >
          Copy snippet
        </Button>
        <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          Sync now
        </Button>
        {sync.data ? (
          <span className="text-sm">{`Copied ${sync.data.copied} new or grown transcripts.`}</span>
        ) : null}
        {sync.error ? (
          <span role="alert" className="text-sm text-destructive">
            {sync.error.message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
