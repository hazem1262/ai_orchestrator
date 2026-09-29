import type { PrRef, ReviewSummary } from '@orc/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { usePrStatus } from '@/api/queries/github.ts';
import { useShipSuggest } from '@/api/queries/ship.ts';
import { Button } from '@/components/ui/button.tsx';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useTerminalStore } from '@/stores/terminals.ts';

type Method = 'merge' | 'squash' | 'rebase';

const INVALIDATE = [['review'], ['diff'], ['worktrees']] as const;
const TEXTAREA = 'font-mono text-xs md:text-xs';

export function ShipPanel({ summary: s }: { summary: ReviewSummary }) {
  const draftId = useId();
  const suggest = useShipSuggest(s.cwd, s.sessionPk);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [method, setMethod] = useState<Method>('squash');
  const [created, setCreated] = useState<PrRef | null>(null);
  const openTerminal = useTerminalStore((st) => st.open);

  useEffect(() => {
    if (!suggest.data) return;
    setMessage(suggest.data.message);
    setTitle(suggest.data.title);
    setBody(suggest.data.body);
    setBase(suggest.data.base);
  }, [suggest.data]);

  const prRef = created ?? s.pr?.pr ?? null;
  const pr = usePrStatus(prRef);
  const qc = useQueryClient();
  const hasSummaryPr = Boolean(s.pr);
  // The daemon fills its PR cache only when the status is fetched, after the create's refetch of
  // the review summary; refetch it again once the status is known so the summary shows the PR.
  useEffect(() => {
    if (pr.data && !hasSummaryPr) void qc.invalidateQueries({ queryKey: ['review'] });
  }, [pr.data, hasSummaryPr, qc]);
  const commit = useConfirmedMutation(
    (m: string, confirm: boolean) => getApiClient().shipCommit({ cwd: s.cwd, message: m, confirm }),
    { invalidate: INVALIDATE },
  );
  const push = useConfirmedMutation(
    (_: null, confirm: boolean) => getApiClient().shipPush({ cwd: s.cwd, confirm }),
    { invalidate: INVALIDATE },
  );
  const open = useConfirmedMutation(
    (v: { title: string; body: string; base: string; draft: boolean }, confirm: boolean) =>
      getApiClient().shipPr({ cwd: s.cwd, ...v, confirm }),
    { invalidate: INVALIDATE, onSuccess: (r) => setCreated(r) },
  );
  const merge = useConfirmedMutation(
    (v: { pr: PrRef; method: Method }, confirm: boolean) => getApiClient().shipMerge({ ...v, confirm }),
    { invalidate: [...INVALIDATE, ['pr']] },
  );
  const backmerge = useConfirmedMutation(
    (_: null, confirm: boolean) =>
      getApiClient().shipBackmerge({
        cwd: s.cwd,
        projectId: s.worktree?.projectId ?? '',
        ticket: s.worktree?.ticket ?? null,
        confirm,
      }),
    { onSuccess: (r) => openTerminal(r.ptyId, 'backmerge') },
  );

  const status = pr.data;
  const error = commit.error ?? push.error ?? open.error ?? merge.error ?? backmerge.error;
  return (
    <section aria-label="Ship" className="rounded-xl border bg-card text-sm text-card-foreground">
      <CardHeader className="p-2">
        <CardTitle className="text-sm">Ship</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-2 pt-0">
        <Textarea
          aria-label="Commit message"
          className={TEXTAREA}
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="flex gap-1">
          <Button size="sm" disabled={!message || commit.busy} onClick={() => void commit.run(message)}>
            Commit
          </Button>
          <Button size="sm" variant="outline" disabled={push.busy} onClick={() => void push.run(null)}>
            Push
          </Button>
        </div>
        {!prRef && (
          <div className="space-y-1">
            <Input
              aria-label="PR title"
              className="w-full"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              aria-label="PR body"
              className={TEXTAREA}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Input
                aria-label="Base branch"
                className="w-24"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
              <div className="flex items-center gap-1">
                <Checkbox id={draftId} checked={draft} onCheckedChange={setDraft} />
                <label htmlFor={draftId}>Draft</label>
              </div>
              <Button
                size="sm"
                disabled={!title || !base || open.busy}
                onClick={() => void open.run({ title, body, base, draft })}
              >
                Create PR
              </Button>
            </div>
          </div>
        )}
        {prRef && (
          <div className="space-y-1">
            <a href={prRef.url} target="_blank" rel="noreferrer" className="underline">
              {status ? `#${prRef.number} · ${status.state} · checks ${status.checks}` : `#${prRef.number}`}
            </a>
            {status?.failedChecks.length ? (
              <p className="text-destructive">Failing: {status.failedChecks.join(', ')}</p>
            ) : null}
            {status?.state === 'open' && (
              <div className="flex items-center gap-1">
                <NativeSelect
                  aria-label="Merge method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as Method)}
                >
                  <option value="squash">squash</option>
                  <option value="merge">merge</option>
                  <option value="rebase">rebase</option>
                </NativeSelect>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={merge.busy}
                  onClick={() => void merge.run({ pr: prRef, method })}
                >
                  Merge
                </Button>
              </div>
            )}
            {status?.state === 'merged' && s.worktree?.projectId && (
              <Button size="sm" variant="outline" onClick={() => void backmerge.run(null)}>
                Backmerge
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
      </CardContent>
      <GitConfirmDialog
        request={commit.pending}
        busy={commit.busy}
        title="Commit changes?"
        confirmLabel="Commit"
        onConfirm={() => void commit.confirm()}
        onCancel={commit.cancel}
      />
      <GitConfirmDialog
        request={push.pending}
        busy={push.busy}
        title="Push branch?"
        confirmLabel="Push"
        onConfirm={() => void push.confirm()}
        onCancel={push.cancel}
      />
      <GitConfirmDialog
        request={open.pending}
        busy={open.busy}
        title="Open pull request?"
        confirmLabel="Create PR"
        onConfirm={() => void open.confirm()}
        onCancel={open.cancel}
      />
      <GitConfirmDialog
        request={merge.pending}
        busy={merge.busy}
        title="Merge pull request?"
        confirmLabel="Merge"
        danger
        onConfirm={() => void merge.confirm()}
        onCancel={merge.cancel}
      />
      <GitConfirmDialog
        request={backmerge.pending}
        busy={backmerge.busy}
        title="Start backmerge?"
        confirmLabel="Start"
        onConfirm={() => void backmerge.confirm()}
        onCancel={backmerge.cancel}
      />
    </section>
  );
}
