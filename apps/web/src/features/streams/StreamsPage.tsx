import type { StreamStage, WorkStream } from '@orc/core';
import { AlertTriangle, ChevronLeft, ChevronRight, Kanban, List, RefreshCw, Waves } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { scopeProject } from '@/api/queries/inbox.ts';
import { useRefreshStreams, useStreams } from '@/api/queries/streams.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { formatUsd } from '@/features/limits/format.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useStreamViewStore } from '@/stores/streams.ts';
import {
  cleanTitle,
  formatActivity,
  groupByStage,
  STAGE_BADGE_VARIANT,
  STAGE_LABELS,
  STAGE_ORDER,
  streamHref,
} from './stages.ts';

const PAGE_SIZE = 15;

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

function titleOf(s: WorkStream): string {
  return cleanTitle(s.title) || 'Untitled stream';
}

function StreamCard({ s, showStage = false }: { s: WorkStream; showStage?: boolean }) {
  return (
    <article className="flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <a className="truncate font-medium underline" href={streamHref(s.ticket)}>
          {s.ticket}
        </a>
        {showStage ? <Badge variant={STAGE_BADGE_VARIANT[s.stage]}>{STAGE_LABELS[s.stage]}</Badge> : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatUsd(s.costUsd)}</span>
      </div>
      <a
        href={streamHref(s.ticket)}
        className="line-clamp-2 min-w-0 break-words text-muted-foreground hover:underline"
      >
        {titleOf(s)}
      </a>
      <p className="text-xs text-muted-foreground">{counts(s)}</p>
      <p className="text-xs text-muted-foreground">{formatActivity(s.lastActivityAt)}</p>
    </article>
  );
}

function StreamTable({ streams }: { streams: WorkStream[] }) {
  return (
    <Table aria-label="Streams" className="table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-28">Ticket</TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="w-32">Stage</TableHead>
          <TableHead className="w-44">Links</TableHead>
          <TableHead className="w-20 text-right">Cost</TableHead>
          <TableHead className="w-40 text-right">Last activity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {streams.map((s) => (
          <TableRow key={s.ticket}>
            <TableCell>
              <a className="underline" href={streamHref(s.ticket)}>
                {s.ticket}
              </a>
            </TableCell>
            <TableCell className="max-w-0 truncate" title={titleOf(s)}>
              <a className="hover:underline" href={streamHref(s.ticket)}>
                {titleOf(s)}
              </a>
            </TableCell>
            <TableCell>
              <Badge variant={STAGE_BADGE_VARIANT[s.stage]}>{STAGE_LABELS[s.stage]}</Badge>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{counts(s)}</TableCell>
            <TableCell className="text-right">{formatUsd(s.costUsd)}</TableCell>
            <TableCell className="text-right text-xs text-muted-foreground">
              {formatActivity(s.lastActivityAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

function Pages({
  page,
  pages,
  from,
  to,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (total === 0) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
      <span className="text-xs">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

function StreamBoard({ streams, mobile }: { streams: WorkStream[]; mobile: boolean }) {
  return (
    <ScrollArea className="w-full pb-2">
      <div className="flex min-w-0 gap-3">
        {groupByStage(streams).map((col) => (
          <section
            key={col.stage}
            aria-label={col.label}
            className={cn('flex shrink-0 flex-col gap-2', mobile ? 'w-[78vw]' : 'w-64')}
          >
            <h2 className="flex items-center gap-2 text-sm font-medium">
              {col.label}
              <Badge variant="secondary">{col.streams.length}</Badge>
            </h2>
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto rounded-lg bg-muted/40 p-2">
              {col.streams.map((s) => (
                <StreamCard key={s.ticket} s={s} />
              ))}
              {col.streams.length === 0 ? (
                <p className="p-1 text-xs text-muted-foreground">Nothing here</p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

function StreamsSkeleton({ mobile }: { mobile: boolean }) {
  const rows = [0, 1, 2, 3, 4, 5];
  if (mobile) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading streams" className="flex flex-col gap-2">
        {rows.slice(0, 4).map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="ml-auto h-4 w-10" />
            </div>
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading streams"
      className="flex flex-col gap-0 rounded-lg border"
    >
      {rows.map((i) => (
        <div key={i} className="flex items-center gap-4 border-b p-3 last:border-0">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" style={{ maxWidth: `${60 - i * 6}%` }} />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function StreamsPage() {
  const stageId = useId();
  const projectId = scopeProject(useProjectStore((st) => st.projectId));
  const [stage, setStage] = useState<StreamStage | ''>('');
  const [rawPage, setRawPage] = useState(0);
  const view = useStreamViewStore((st) => st.view);
  const setView = useStreamViewStore((st) => st.setView);
  const q = useStreams({ ...(projectId ? { projectId } : {}), ...(stage ? { stage } : {}) });
  const refresh = useRefreshStreams();
  const isMobile = useIsMobile();

  const streams = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
    [q.data],
  );
  const pages = Math.max(1, Math.ceil(streams.length / PAGE_SIZE));
  const page = Math.min(rawPage, pages - 1);
  const shown = streams.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function onStage(next: StreamStage | '') {
    setStage(next);
    setRawPage(0);
  }

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
            onChange={(e) => onStage(e.target.value as StreamStage | '')}
          >
            <option value="">all</option>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(v) => v && setView(v as 'list' | 'kanban')}
          aria-label="View"
        >
          <ToggleGroupItem value="list" aria-label="List" className="gap-1.5 px-2.5">
            <List />
            List
          </ToggleGroupItem>
          <ToggleGroupItem value="kanban" aria-label="Board" className="gap-1.5 px-2.5">
            <Kanban />
            Board
          </ToggleGroupItem>
        </ToggleGroup>
        <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={refresh.isPending ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </header>

      {q.isError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Could not load work streams.</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={() => q.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : q.isLoading ? (
        <StreamsSkeleton mobile={isMobile} />
      ) : streams.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Waves />
            </EmptyMedia>
            <EmptyTitle>{stage ? 'No streams in this stage' : 'No streams yet'}</EmptyTitle>
            <EmptyDescription>
              {stage
                ? 'Pick another stage, or show all.'
                : 'Work streams are built from tickets in prompts, branches, PRs, plans, worktrees and wstack workflows, for projects with work streams enabled.'}
            </EmptyDescription>
          </EmptyHeader>
          {stage ? (
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={() => onStage('')}>
                Show all stages
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : view === 'kanban' ? (
        <StreamBoard streams={streams} mobile={isMobile} />
      ) : (
        <>
          {isMobile ? <StreamCards streams={shown} /> : <StreamTable streams={shown} />}
          <Pages
            page={page}
            pages={pages}
            from={page * PAGE_SIZE + 1}
            to={page * PAGE_SIZE + shown.length}
            total={streams.length}
            onPage={setRawPage}
          />
        </>
      )}
    </div>
  );
}
