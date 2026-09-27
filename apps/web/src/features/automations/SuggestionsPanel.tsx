import type { Suggestion } from '@orc/api-contract';
import { getApiClient } from '@/api/client.ts';
import {
  automationKeys,
  useDismissSuggestion,
  useRefreshSuggestions,
  useSuggestions,
} from '@/api/queries/automations.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { ConfirmActionDialog } from './ConfirmActionDialog.tsx';

type AcceptVars = { id: string; title: string };

/**
 * Start goes through the daemon's `409 confirmation_required` flow and its dialog. A `confirm`
 * callback replaces that dialog: it is asked first, and a yes sends `confirm: true`.
 */
export function SuggestionsPanel({ confirm }: { confirm?: (message: string) => boolean }) {
  const { data: suggestions = [], isLoading, error } = useSuggestions();
  const refresh = useRefreshSuggestions();
  const dismiss = useDismissSuggestion();
  const openTerminal = useTerminalStore((s) => s.open);
  const accept = useConfirmedMutation(
    (v: AcceptVars, ok: boolean) =>
      ok ? getApiClient().suggestionsAccept(v.id) : getApiClient().suggestionsAccept(v.id, false),
    {
      invalidate: [automationKeys.suggestions],
      onSuccess: (r, v) => {
        if (r.ptyId) openTerminal(r.ptyId, v.title);
      },
    },
  );
  const failure = error ?? refresh.error ?? dismiss.error ?? accept.error;

  const onStart = (s: Suggestion) => {
    const vars = { id: s.id, title: s.title };
    if (!confirm) {
      void accept.run(vars);
      return;
    }
    if (confirm(`Start a Claude session for "${s.title}"?`)) void accept.runConfirmed(vars);
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Suggested tasks">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Suggested tasks</h2>
        <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
        {refresh.data ? (
          <span className="text-xs text-muted-foreground">{refresh.data.added} new</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        From your Linear backlog and new TODO/FIXME comments in app worktrees. Nothing starts until you press
        Start.
      </p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      ) : null}
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {!isLoading && suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suggestions right now.</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {suggestions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-sm">
            <Badge variant="outline">{s.source}</Badge>
            <span className="min-w-0 truncate">{s.title}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {s.file ? `${s.file}${s.line ? `:${s.line}` : ''}` : s.detail}
            </span>
            <div className="ml-auto flex gap-1">
              <Button
                size="sm"
                aria-label={`Start ${s.title}`}
                disabled={accept.busy}
                onClick={() => onStart(s)}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Dismiss ${s.title}`}
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(s.id)}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmActionDialog
        request={accept.pending}
        busy={accept.busy}
        title="Start suggested task?"
        confirmLabel="Start"
        onConfirm={() => void accept.confirm()}
        onCancel={accept.cancel}
      />
    </section>
  );
}
