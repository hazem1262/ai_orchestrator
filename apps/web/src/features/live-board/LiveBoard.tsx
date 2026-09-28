import type { Session } from '@orc/core';
import { Activity, AlertCircle, ChevronDown, Columns2, LayoutGrid, List } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { pkOf } from '@/api/live-events.ts';
import { scopeProject } from '@/api/queries/inbox.ts';
import { useLive } from '@/api/queries/live.ts';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { formatCost } from '@/lib/format.ts';
import { type LiveGroupBy, type LiveLayout, useLiveLayoutStore } from '@/stores/live-layout.ts';
import { useProjectStore } from '@/stores/project.ts';
import { SessionCard } from './SessionCard.tsx';
import { filterByProject, groupLive, isAttention, sortLive } from './sort.ts';

const LAYOUTS: Array<{ id: LiveLayout; label: string; icon: typeof LayoutGrid }> = [
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
  { id: 'list', label: 'List', icon: List },
  { id: 'split', label: 'Split', icon: Columns2 },
];

const GROUPS: Array<{ id: LiveGroupBy; label: string }> = [
  { id: 'none', label: 'No grouping' },
  { id: 'project', label: 'Group by project' },
  { id: 'ticket', label: 'Group by ticket' },
  { id: 'source', label: 'Group by source' },
];

export type LiveFilter = 'all' | 'attention' | 'running';

const GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3';

/** Time in state ticks every second; tests pass a fixed clock. */
function useNow(now?: () => number): number {
  const clock = now ?? Date.now;
  const [t, setT] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setT(clock()), 1000);
    return () => clearInterval(id);
  }, [clock]);
  return t;
}

const needsYou = (s: Session) => s.live !== null && s.live !== undefined && isAttention(s.live.status);
const running = (s: Session) => s.live?.status === 'busy';

export function LiveBoard({ now }: { now?: () => number }) {
  const { data, isLoading, error, refetch, isRefetching } = useLive();
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const { layout, pinned, groupBy, setLayout, togglePin, setGroupBy } = useLiveLayoutStore();
  const [filter, setFilter] = useState<LiveFilter>('all');
  const t = useNow(now);

  const sessions = useMemo(() => sortLive(filterByProject(data ?? [], projectId)), [data, projectId]);
  const attention = sessions.filter(needsYou);
  const busy = sessions.filter(running);
  const visible = filter === 'attention' ? attention : filter === 'running' ? busy : sessions;
  const cost = sessions.reduce((n, s) => n + (s.usage.costUsd ?? 0), 0);
  const pinnedSessions = pinned
    .map((pk) => sessions.find((s) => pkOf(s) === pk))
    .filter((s): s is Session => s !== undefined);
  const failed = error !== null && data === undefined;
  const ready = !isLoading && !failed;

  const card = (s: Session, compact = false) => (
    <SessionCard
      key={pkOf(s)}
      session={s}
      now={t}
      compact={compact}
      pinned={pinned.includes(pkOf(s))}
      onTogglePin={() => togglePin(pkOf(s))}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Live</h1>
          <p className="text-sm text-muted-foreground">
            {ready && sessions.length > 0
              ? `${sessions.length} sessions · ${attention.length} need you${cost > 0 ? ` · ${formatCost(cost)} spent` : ''}`
              : 'Every running agent session, the ones that need you first.'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={layout}
            onValueChange={(v) => {
              if (v) setLayout(v as LiveLayout);
            }}
            role="radiogroup"
            aria-label="Layout"
          >
            {LAYOUTS.map((l) => (
              <ToggleGroupItem key={l.id} value={l.id} aria-label={l.label} className="gap-1.5 px-2.5">
                <l.icon aria-hidden />
                <span className="hidden md:inline">{l.label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="w-44 justify-between font-normal">
                {GROUPS.find((g) => g.id === groupBy)?.label}
                <ChevronDown className="text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setGroupBy(v as LiveGroupBy)}>
                {GROUPS.map((g) => (
                  <DropdownMenuRadioItem key={g.id} value={g.id}>
                    {g.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {ready && sessions.length > 0 && layout !== 'split' ? (
        <ToggleGroup
          type="single"
          size="sm"
          value={filter}
          onValueChange={(v) => {
            if (v) setFilter(v as LiveFilter);
          }}
          role="radiogroup"
          aria-label="Filter sessions"
          className="flex-wrap justify-start"
        >
          <ToggleGroupItem value="all" className="gap-1.5 px-2.5">
            All <Badge variant="secondary">{sessions.length}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem value="attention" className="gap-1.5 px-2.5">
            Needs you{' '}
            <Badge variant="secondary" className="bg-warning/15 text-warning">
              {attention.length}
            </Badge>
          </ToggleGroupItem>
          <ToggleGroupItem value="running" className="gap-1.5 px-2.5">
            Running{' '}
            <Badge variant="secondary" className="bg-info/15 text-info">
              {busy.length}
            </Badge>
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}

      {failed ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Couldn't load live sessions</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" disabled={isRefetching} onClick={() => void refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : isLoading ? (
        <BoardSkeleton />
      ) : sessions.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Activity />
            </EmptyMedia>
            <EmptyTitle>No live sessions right now.</EmptyTitle>
            <EmptyDescription>
              Sessions you start here, and Claude or Codex sessions running in any terminal, show up within a
              second.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : layout === 'split' ? (
        pinnedSessions.length < 2 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Columns2 />
              </EmptyMedia>
              <EmptyTitle>Pin 2–4 sessions to compare them side by side.</EmptyTitle>
              <EmptyDescription>
                Use “Pin to split” in a session's ⋯ menu, then come back here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section
            aria-label="Split view"
            data-columns={pinnedSessions.length}
            className="grid snap-x auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
          >
            {pinnedSessions.map((s) => (
              <div key={pkOf(s)} className="flex min-w-0 snap-start flex-col">
                {card(s)}
              </div>
            ))}
          </section>
        )
      ) : visible.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Activity />
            </EmptyMedia>
            <EmptyTitle>Nothing matches this filter</EmptyTitle>
            <EmptyDescription>No session is in this state right now.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => setFilter('all')}>
              Show all
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        groupLive(visible, groupBy).map((g) => {
          const body = (
            <div key={g.key} className={layout === 'grid' ? GRID : 'flex flex-col gap-2'}>
              {g.sessions.map((s) => card(s, layout === 'list'))}
            </div>
          );
          return groupBy === 'none' ? (
            <div key={g.key}>{body}</div>
          ) : (
            <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                {g.label}
                <Badge variant="secondary">{g.sessions.length}</Badge>
              </h2>
              {body}
            </section>
          );
        })
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div role="status" className={GRID} aria-busy="true" aria-label="Loading live sessions">
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder list
        <Card key={i}>
          <CardHeader className="gap-2">
            <div className="flex gap-2">
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="ml-auto h-4 w-10" />
            </div>
            <Skeleton className="h-5 w-3/4" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </CardContent>
          <CardFooter className="gap-2 px-4 py-2.5">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="ml-auto h-7 w-28" />
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
