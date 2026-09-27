import type { StreamLinkKind, StreamStage } from '@orc/core';
import { type FormEvent, useId, useState } from 'react';
import { useLinkStream, useStream, useUnlinkStream } from '@/api/queries/streams.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { GoalEditor } from '@/features/goals/GoalEditor.tsx';
import { formatPctValue, formatUsd } from '@/features/limits/format.ts';
import { formatActivity, STAGE_LABELS, STAGE_ORDER, sessionHref, stageIndex } from './stages.ts';

const LINK_KINDS: StreamLinkKind[] = ['session', 'pr', 'plan', 'worktree', 'workflow'];
const CARD = 'rounded border p-3';

function StageBar({ stage }: { stage: StreamStage }) {
  const current = stageIndex(stage);
  return (
    <ol aria-label="Stage" className="flex flex-wrap items-center gap-1 text-xs">
      {STAGE_ORDER.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? 'step' : undefined}
          className={i <= current ? 'font-semibold text-success' : 'text-muted-foreground'}
        >
          {STAGE_LABELS[s]}
          {i < STAGE_ORDER.length - 1 ? <span className="px-1 text-muted-foreground">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

function LinkForm({ ticket }: { ticket: string }) {
  const id = useId();
  const link = useLinkStream(ticket);
  const [kind, setKind] = useState<StreamLinkKind>('session');
  const [ref, setRef] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = ref.trim();
    if (value.length === 0) return;
    link.mutate({ kind, ref: value }, { onSuccess: () => setRef('') });
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
      <span className="flex flex-col gap-0.5">
        <label htmlFor={`${id}-kind`}>Link kind</label>
        <NativeSelect
          id={`${id}-kind`}
          className="h-7 text-xs"
          value={kind}
          onChange={(e) => setKind(e.target.value as StreamLinkKind)}
        >
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <label htmlFor={`${id}-ref`}>Link reference</label>
        <Input
          id={`${id}-ref`}
          className="h-7 text-xs"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="claude:s-basic, PR url, path…"
        />
      </span>
      <Button type="submit" size="sm" disabled={link.isPending}>
        Link
      </Button>
      {link.isError ? (
        <p role="alert" className="w-full text-destructive">
          Could not link {ref.trim()}.
        </p>
      ) : null}
    </form>
  );
}

export function StreamDetailPage({ ticket }: { ticket: string }) {
  const q = useStream(ticket);
  const unlink = useUnlinkStream(ticket);

  if (q.isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading stream…</p>;
  if (q.isError || !q.data) return <p className="p-4 text-sm">No stream for {ticket}.</p>;
  const { stream, prsDetailed, links, timeline, handoff, budget } = q.data;
  const unlinked = links.filter((l) => l.excluded);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">{stream.ticket}</h1>
        {stream.title ? <p className="text-muted-foreground">{stream.title}</p> : null}
        <StageBar stage={stream.stage} />
        <p className="text-sm">
          <strong>{formatUsd(stream.costUsd)}</strong>{' '}
          {budget.limitUsd !== null ? (
            <span className={budget.ok ? 'text-muted-foreground' : 'text-destructive'}>
              {`${formatPctValue(budget.pct)} of ${formatUsd(budget.limitUsd)}`}
            </span>
          ) : (
            <span className="text-muted-foreground">no budget set</span>
          )}
          {' · '}
          <span className="text-muted-foreground">last activity {formatActivity(stream.lastActivityAt)}</span>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Stream goal" className={CARD}>
          <GoalEditor targetType="stream" targetId={stream.ticket} />
        </section>

        <section aria-label="Next steps" className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">What's next</h2>
          {handoff ? (
            <>
              <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                From the handoff of {handoff.sessionId} <Badge variant="outline">{handoff.status}</Badge>
              </p>
              <ol className="ml-4 list-decimal text-sm">
                {handoff.nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {handoff.blockers.length > 0 ? (
                <p className="text-sm text-warning">Blocked: {handoff.blockers.join('; ')}</p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No handoff yet. Open a session and create one to capture the next steps.
            </p>
          )}
        </section>

        <section aria-label="Pull requests" className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Pull requests</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {prsDetailed.map((p) => (
              <li key={p.pr.url} className="flex flex-wrap items-center gap-2">
                <a className="underline" href={p.pr.url} target="_blank" rel="noreferrer">
                  {`#${p.pr.number} ${p.title}`}
                </a>
                <Badge variant="outline">{p.state}</Badge>
                {p.isBackmerge ? <Badge variant="secondary">backmerge</Badge> : null}
                <span className="text-xs text-muted-foreground">
                  checks {p.checks} · review {p.review}
                </span>
              </li>
            ))}
            {prsDetailed.length === 0 ? <li className="text-muted-foreground">none</li> : null}
          </ul>
        </section>

        <section aria-label="Sessions, plans and worktrees" className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Sessions, plans and worktrees</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {stream.sessionIds.map((pk) => (
              <li key={pk} className="flex items-center justify-between gap-2">
                <a className="underline" href={sessionHref(pk)}>
                  {pk}
                </a>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Unlink session ${pk}`}
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate({ kind: 'session', ref: pk })}
                >
                  ✕
                </Button>
              </li>
            ))}
            {stream.plans.map((p) => (
              <li key={p} className="truncate text-muted-foreground">
                {p}
              </li>
            ))}
            {stream.worktrees.map((w) => (
              <li key={w} className="truncate text-muted-foreground">
                {w}
              </li>
            ))}
          </ul>
          {unlinked.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {unlinked.map((l) => `${l.ref} (unlinked)`).join(', ')}
            </p>
          ) : null}
          <LinkForm ticket={stream.ticket} />
        </section>
      </div>

      <section aria-label="Timeline" className={CARD}>
        <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
        <ol className="flex flex-col gap-2 text-sm">
          {timeline.map((i) => (
            <li key={`${i.kind}-${i.ref}-${i.ts}`} className="flex flex-col">
              <span className="text-xs text-muted-foreground">
                {formatActivity(i.ts)} · {i.kind}
              </span>
              <span>{i.title}</span>
              {i.detail ? <span className="text-xs text-muted-foreground">{i.detail}</span> : null}
            </li>
          ))}
          {timeline.length === 0 ? <li className="text-muted-foreground">nothing yet</li> : null}
        </ol>
      </section>
    </div>
  );
}
