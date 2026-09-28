import type { StreamStage, WorkStream } from '@orc/core';
import { useId, useState } from 'react';
import { scopeProject } from '@/api/queries/inbox.ts';
import { useRefreshStreams, useStreams } from '@/api/queries/streams.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { formatUsd } from '@/features/limits/format.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useStreamViewStore } from '@/stores/streams.ts';
import { formatActivity, groupByStage, STAGE_LABELS, STAGE_ORDER, streamHref } from './stages.ts';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function counts(s: WorkStream): string {
  return [
    plural(s.sessionIds.length, 'session'),
    plural(s.prs.length, 'PR'),
    plural(s.plans.length, 'plan'),
  ].join(' · ');
}

function StreamCard({ s, showStage = false }: { s: WorkStream; showStage?: boolean }) {
  return (
    <article className="flex min-w-0 flex-col gap-0.5 rounded border p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <a className="font-medium underline" href={streamHref(s.ticket)}>
          {s.ticket}
        </a>
        {showStage ? <Badge variant="outline">{STAGE_LABELS[s.stage]}</Badge> : null}
        <span className={showStage ? 'ml-auto' : undefined}>{formatUsd(s.costUsd)}</span>
      </div>
      {s.title ? <p className="truncate text-muted-foreground">{s.title}</p> : null}
      <p className="text-xs text-muted-foreground">{counts(s)}</p>
      <p className="text-xs text-muted-foreground">{formatActivity(s.lastActivityAt)}</p>
    </article>
  );
}

function StreamTable({ streams }: { streams: WorkStream[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 font-medium">ticket</th>
          <th className="py-1 font-medium">title</th>
          <th className="py-1 font-medium">stage</th>
          <th className="py-1 font-medium">cost</th>
          <th className="py-1 font-medium">links</th>
          <th className="py-1 font-medium">last activity</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((s) => (
          <tr key={s.ticket} className="border-t">
            <td className="py-1">
              <a className="underline" href={streamHref(s.ticket)}>
                {s.ticket}
              </a>
            </td>
            <td className="max-w-md truncate py-1">{s.title ?? '—'}</td>
            <td className="py-1">
              <Badge variant="outline">{STAGE_LABELS[s.stage]}</Badge>
            </td>
            <td className="py-1">{formatUsd(s.costUsd)}</td>
            <td className="py-1 text-xs text-muted-foreground">{counts(s)}</td>
            <td className="py-1 text-xs text-muted-foreground">{formatActivity(s.lastActivityAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The phone layout of the list view: one card per stream instead of a six-column table. */
function StreamCards({ streams }: { streams: WorkStream[] }) {
  return (
    <div className="flex flex-col gap-2">
      {streams.map((s) => (
        <StreamCard key={s.ticket} s={s} showStage />
      ))}
    </div>
  );
}

function StreamBoard({ streams }: { streams: WorkStream[] }) {
  return (
    <div className="flex min-w-0 gap-2 overflow-x-auto pb-2">
      {groupByStage(streams).map((col) => (
        <section key={col.stage} aria-label={col.label} className="flex w-56 shrink-0 flex-col gap-2">
          <h2 className="text-xs font-semibold text-muted-foreground">
            {col.label} ({col.streams.length})
          </h2>
          {col.streams.map((s) => (
            <StreamCard key={s.ticket} s={s} />
          ))}
        </section>
      ))}
    </div>
  );
}

export function StreamsPage() {
  const stageId = useId();
  const projectId = scopeProject(useProjectStore((st) => st.projectId));
  const [stage, setStage] = useState<StreamStage | ''>('');
  const view = useStreamViewStore((st) => st.view);
  const setView = useStreamViewStore((st) => st.setView);
  const q = useStreams({ ...(projectId ? { projectId } : {}), ...(stage ? { stage } : {}) });
  const refresh = useRefreshStreams();
  const streams = q.data ?? [];
  const isMobile = useIsMobile();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Work streams</h1>
        <span className="flex items-center gap-1 text-xs">
          <label htmlFor={stageId}>Stage</label>
          <NativeSelect
            id={stageId}
            className="h-7 text-xs"
            value={stage}
            onChange={(e) => setStage(e.target.value as StreamStage | '')}
          >
            <option value="">all</option>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </span>
        <fieldset aria-label="View" className="flex gap-1">
          <Button
            size="sm"
            variant={view === 'list' ? 'default' : 'outline'}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </Button>
          <Button
            size="sm"
            variant={view === 'kanban' ? 'default' : 'outline'}
            aria-pressed={view === 'kanban'}
            onClick={() => setView('kanban')}
          >
            Kanban
          </Button>
        </fieldset>
        <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          Refresh
        </Button>
      </header>

      {q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load work streams.
        </p>
      ) : null}
      {q.isLoading ? <p className="text-sm text-muted-foreground">Loading streams…</p> : null}
      {q.isSuccess && streams.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No streams yet. Work streams are built from tickets in prompts, branches, PRs, plans, worktrees and
          wstack workflows, for projects with work streams enabled.
        </p>
      ) : null}

      {view === 'kanban' ? (
        <StreamBoard streams={streams} />
      ) : isMobile ? (
        <StreamCards streams={streams} />
      ) : (
        <StreamTable streams={streams} />
      )}
    </div>
  );
}
