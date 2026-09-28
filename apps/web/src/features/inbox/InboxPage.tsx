import type { InboxItem, InboxState } from '@orc/core';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, Inbox as InboxIcon, RotateCw, TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { pkOf } from '@/api/live-events.ts';
import { scopeProject, useInbox } from '@/api/queries/inbox.ts';
import { useLive } from '@/api/queries/live.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { Kbd, KbdGroup } from '@/components/ui/kbd.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { formatDuration } from '@/features/live-board/sort.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { DailyUpdateButton } from '@/features/share/DailyUpdateButton.tsx';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { InboxCard } from './InboxCard.tsx';
import { InboxItemActions } from './InboxItemActions.tsx';
import { DuplicateCount, KindBadge } from './KindBadge.tsx';
import { groupItems, hasDetail, type InboxGroup, isTriageable, sessionRef } from './kinds.ts';
import { RowActions } from './RowActions.tsx';
import { snoozePresets } from './snooze.ts';
import { useInboxKeys } from './useInboxKeys.ts';
import { type InboxTriage, useInboxTriage } from './useInboxTriage.ts';

export { KIND_LABEL } from './kinds.ts';

type Tab = 'open' | 'snoozed' | 'done';
interface TabDef {
  id: Tab;
  label: string;
  states: InboxState[];
  empty: { title: string; description: string };
}

const TABS: [TabDef, TabDef, TabDef] = [
  {
    id: 'open',
    label: 'Open',
    states: ['open'],
    empty: {
      title: 'Nothing needs you right now.',
      description: 'Plan approvals, failing tests, reviews and PR events land here as sessions raise them.',
    },
  },
  {
    id: 'snoozed',
    label: 'Snoozed',
    states: ['snoozed'],
    empty: { title: 'Nothing snoozed.', description: 'Items you snooze wait here until their time comes.' },
  },
  {
    id: 'done',
    label: 'Done',
    states: ['done', 'auto_resolved'],
    empty: {
      title: 'Nothing done yet.',
      description: 'Items you finish, or that resolve on their own, show here.',
    },
  },
];

const tabDef = (id: Tab): TabDef => TABS.find((t) => t.id === id) ?? TABS[0];

/** The two tabs that are not showing, in a fixed order; their lists only feed the tab counts. */
function otherTabs(id: Tab): [TabDef, TabDef] {
  const [a, b] = TABS.filter((t) => t.id !== id);
  return [a ?? TABS[1], b ?? TABS[2]];
}

export function InboxPage({ now }: { now?: () => number } = {}) {
  const clock = now ?? Date.now;
  const [tab, setTab] = useState<Tab>('open');
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  // The other tabs' lists are read before the shown one so the shown list is always the last fetch.
  const [otherA, otherB] = otherTabs(tab);
  const countA = useInbox({ state: otherA.states, projectId }).data?.length;
  const countB = useInbox({ state: otherB.states, projectId }).data?.length;
  const current = tabDef(tab);
  const { data: items = [], isLoading, error, refetch } = useInbox({ state: current.states, projectId });
  const counts: Partial<Record<Tab, number>> = {
    [otherA.id]: countA,
    [otherB.id]: countB,
    [tab]: isLoading ? undefined : items.length,
  };
  const groups = useMemo(() => groupItems(items), [items]);
  const liveSessions = useLive().data ?? [];
  const triage = useInboxTriage();
  const navigate = useNavigate();
  const openTerminal = useTerminalStore((t) => t.open);
  const isMobile = useIsMobile();

  const ownedPty = (item: InboxItem): string | null => {
    const ref = sessionRef(item);
    if (!ref) return null;
    const s = liveSessions.find((x) => pkOf(x) === `${ref.source}:${ref.id}`);
    return s?.live?.ownership === 'owned' && s.live.status !== 'ended' ? s.live.ptyId : null;
  };

  const onOpen = useCallback(
    (i: number) => {
      const lead = groups[i]?.lead;
      const ref = lead ? sessionRef(lead) : null;
      if (ref) void navigate({ to: '/sessions/$source/$id', params: ref });
    },
    [groups, navigate],
  );

  const onDone = useCallback(
    (i: number) => {
      const g = groups[i];
      if (g && isTriageable(g.lead)) triage.done(g);
    },
    [groups, triage],
  );

  const onSnooze = useCallback(
    (i: number) => {
      const g = groups[i];
      const first = snoozePresets(new Date(clock()))[0];
      if (g && first && isTriageable(g.lead)) triage.snooze(g, first.until, first.label);
    },
    [groups, clock, triage],
  );

  const { selected, setSelected } = useInboxKeys({ count: groups.length, onDone, onSnooze, onOpen });

  const openCount = counts.open;
  const deciding =
    tab === 'open' ? items.filter((i) => i.kind === 'plan_approval' || i.kind === 'waiting').length : 0;

  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-3 md:p-6">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
              {openCount ? <Badge variant="secondary">{openCount}</Badge> : null}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tab === 'open' && !isLoading && !error
                ? `${items.length} open · ${deciding} waiting on a decision`
                : 'Everything that needs you, newest first.'}
            </p>
          </div>
          {isMobile ? null : (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <p className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
                <KbdGroup>
                  <Kbd>j</Kbd>
                  <Kbd>k</Kbd>
                </KbdGroup>
                move
                <Kbd>e</Kbd>
                done
                <Kbd>s</Kbd>
                snooze 1h
                <Kbd>↵</Kbd>
                open
              </p>
              <DailyUpdateButton />
            </div>
          )}
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            setSelected(0);
          }}
        >
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="px-3">
                {t.label}
                {counts[t.id] !== undefined ? (
                  <span aria-hidden="true" className="font-mono text-xs text-muted-foreground tabular-nums">
                    {counts[t.id]}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={tab} className="pt-3">
            {error ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Couldn't load the inbox</AlertTitle>
                <AlertDescription>
                  <p>{error.message}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void refetch()}>
                    <RotateCw />
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : isLoading ? (
              <InboxSkeleton mobile={isMobile} />
            ) : groups.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon />
                  </EmptyMedia>
                  <EmptyTitle>{current.empty.title}</EmptyTitle>
                  <EmptyDescription>{current.empty.description}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : isMobile ? (
              <section aria-label="Inbox items" className="flex flex-col gap-2">
                {groups.map((g, i) => (
                  <InboxCard
                    key={g.key}
                    group={g}
                    now={clock()}
                    selected={i === selected}
                    triage={triage}
                    onSelect={() => setSelected(i)}
                  />
                ))}
              </section>
            ) : (
              <Card className="overflow-hidden">
                <div
                  aria-hidden="true"
                  className={cn(ROW_GRID, 'border-b px-3 py-2 text-xs font-medium text-muted-foreground')}
                >
                  <span />
                  <span>Kind</span>
                  <span>Item</span>
                  <span>Ticket</span>
                  <span className="text-right">Age</span>
                  <span />
                </div>
                <ul aria-label="Inbox items">
                  {groups.map((g, i) => (
                    <InboxRow
                      key={g.key}
                      group={g}
                      now={clock()}
                      selected={i === selected}
                      pty={ownedPty(g.lead)}
                      triage={triage}
                      onSelect={() => setSelected(i)}
                      onOpen={() => onOpen(i)}
                      onTerminal={(ptyId) => openTerminal(ptyId, g.lead.reason)}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

const ROW_GRID = 'grid grid-cols-[1rem_9.5rem_minmax(0,1fr)_6.5rem_4rem_11.5rem] items-center gap-x-3';

function InboxRow(props: {
  group: InboxGroup;
  now: number;
  selected: boolean;
  pty: string | null;
  triage: InboxTriage;
  onSelect(): void;
  onOpen(): void;
  onTerminal(ptyId: string): void;
}) {
  const { group, now, selected } = props;
  const item = group.lead;
  const ref = sessionRef(item);
  const detail = hasDetail(item);
  const expanded = selected && detail;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: selection by keyboard is handled by useInboxKeys
    <li
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      className={cn(
        'border-b px-3 py-2 last:border-b-0 hover:bg-muted/40',
        selected && 'bg-accent/70 shadow-[inset_3px_0_0_var(--ring)] hover:bg-accent/70',
      )}
    >
      <div className={ROW_GRID}>
        <span className="text-muted-foreground">
          {detail ? (
            <ChevronRight
              aria-hidden="true"
              className={cn('size-4 transition-transform', expanded && 'rotate-90')}
            />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <KindBadge item={item} />
        </span>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2">
            <span data-reason className="truncate font-medium" title={item.reason}>
              {item.reason}
            </span>
            <DuplicateCount count={group.items.length} />
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {[ref ? `${ref.source}:${ref.id}` : null, item.projectId ?? 'no project']
              .filter(Boolean)
              .join(' · ')}
            {item.snoozeUntil ? ` · until ${new Date(item.snoozeUntil).toLocaleString()}` : ''}
          </p>
        </div>
        <span className="min-w-0">
          {item.ticket ? (
            <Badge variant="outline" className="max-w-full truncate font-mono">
              {item.ticket}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
        <span
          className="text-right font-mono text-xs text-muted-foreground tabular-nums"
          title={item.createdAt}
        >
          {formatDuration(now - Date.parse(item.createdAt))}
        </span>
        <RowActions
          group={group}
          now={now}
          pty={props.pty}
          triage={props.triage}
          onOpen={props.onOpen}
          onTerminal={props.onTerminal}
        />
      </div>
      {expanded ? (
        <div className="mt-2 mb-1 ml-[calc(1rem+0.75rem)]">
          <InboxItemActions item={item} />
        </div>
      ) : null}
    </li>
  );
}

function InboxSkeleton({ mobile }: { mobile: boolean }) {
  const rows = [0, 1, 2, 3, 4, 5];
  if (mobile) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label="Loading inbox">
        {rows.slice(0, 4).map((i) => (
          <Card key={i} className="flex flex-col gap-2 p-3">
            <div className="flex gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="ml-auto h-5 w-10" />
            </div>
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-8 w-40" />
          </Card>
        ))}
      </div>
    );
  }
  return (
    <Card className="overflow-hidden" role="status" aria-busy="true" aria-label="Loading inbox">
      {rows.map((i) => (
        <div key={i} className="flex items-center gap-4 border-b px-3 py-3 last:border-0">
          <Skeleton className="h-5 w-28" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4" style={{ width: `${70 - i * 6}%` }} />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-7 w-32" />
        </div>
      ))}
    </Card>
  );
}
