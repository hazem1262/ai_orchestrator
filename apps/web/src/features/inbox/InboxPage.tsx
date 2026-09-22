import type { InboxItem, InboxKind, InboxState, Source } from '@orc/core';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { pkOf } from '@/api/live-events.ts';
import { scopeProject, useInbox, useInboxAction } from '@/api/queries/inbox.ts';
import { useLive } from '@/api/queries/live.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { formatDuration } from '@/features/live-board/sort.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { snoozePresets } from './snooze.ts';
import { useInboxKeys } from './useInboxKeys.ts';

export const KIND_LABEL: Record<InboxKind, string> = {
  waiting: 'Waiting',
  review: 'Ready for review',
  plan_approval: 'Plan approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests red',
  budget: 'Budget',
  automation_result: 'Automation',
  supervisor_escalation: 'Supervisor',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

type Tab = 'open' | 'snoozed' | 'done';

const TABS: Array<{ id: Tab; label: string; states: InboxState[] }> = [
  { id: 'open', label: 'Open', states: ['open'] },
  { id: 'snoozed', label: 'Snoozed', states: ['snoozed'] },
  { id: 'done', label: 'Done', states: ['done', 'auto_resolved'] },
];

/** The session an item points at, when its payload carries one (contracts §9). */
function sessionRef(item: InboxItem): { source: Source; id: string } | null {
  const { source, id } = item.payload;
  return typeof source === 'string' && typeof id === 'string' ? { source: source as Source, id } : null;
}

export function InboxPage({ now }: { now?: () => number } = {}) {
  const clock = now ?? Date.now;
  const [tab, setTab] = useState<Tab>('open');
  const states = TABS.find((t) => t.id === tab)?.states ?? ['open'];
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const { data: items = [], isLoading } = useInbox({ state: states, projectId });
  const liveSessions = useLive().data ?? [];
  const action = useInboxAction();
  const navigate = useNavigate();
  const openTerminal = useTerminalStore((t) => t.open);

  const ownedPty = (item: InboxItem): string | null => {
    const ref = sessionRef(item);
    if (!ref) return null;
    const s = liveSessions.find((x) => pkOf(x) === `${ref.source}:${ref.id}`);
    return s?.live?.ownership === 'owned' && s.live.status !== 'ended' ? s.live.ptyId : null;
  };

  const onOpen = useCallback(
    (i: number) => {
      const item = items[i];
      const ref = item ? sessionRef(item) : null;
      if (ref) void navigate({ to: '/sessions/$source/$id', params: ref });
    },
    [items, navigate],
  );

  const onDone = useCallback(
    (i: number) => {
      const item = items[i];
      if (item && item.state !== 'done' && item.state !== 'auto_resolved') {
        action.mutate({ id: item.id, action: 'done' });
      }
    },
    [items, action],
  );

  const snooze = useCallback(
    (i: number, until: string) => {
      const item = items[i];
      if (item && item.state !== 'done' && item.state !== 'auto_resolved') {
        action.mutate({ id: item.id, action: 'snooze', until });
      }
    },
    [items, action],
  );

  const onSnooze = useCallback(
    (i: number) => {
      const first = snoozePresets(new Date(clock()))[0];
      if (first) snooze(i, first.until);
    },
    [clock, snooze],
  );

  const { selected, setSelected } = useInboxKeys({ count: items.length, onDone, onSnooze, onOpen });

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <p className="ml-auto text-xs text-muted-foreground">j/k move · e done · s snooze 1h · Enter open</p>
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
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab} className="pt-3">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {!isLoading && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs you right now.</p>
          ) : null}
          <ul aria-label="Inbox items" className="flex flex-col gap-1">
            {items.map((item, i) => (
              <InboxRow
                key={item.id}
                item={item}
                now={clock()}
                selected={i === selected}
                pty={ownedPty(item)}
                onSelect={() => setSelected(i)}
                onOpen={() => onOpen(i)}
                onTerminal={(ptyId) => openTerminal(ptyId, item.reason)}
                onDone={() => onDone(i)}
                onSnooze={(until) => snooze(i, until)}
                onReopen={() => action.mutate({ id: item.id, action: 'reopen' })}
              />
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InboxRow(props: {
  item: InboxItem;
  now: number;
  selected: boolean;
  pty: string | null;
  onSelect(): void;
  onOpen(): void;
  onTerminal(ptyId: string): void;
  onDone(): void;
  onSnooze(until: string): void;
  onReopen(): void;
}) {
  const { item, now, selected, pty } = props;
  const triageable = item.state === 'open' || item.state === 'snoozed';
  const urgent = item.kind === 'error' || item.kind === 'tests_red';
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: selection by keyboard is handled by useInboxKeys
    <li
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded border px-3 py-2',
        selected && 'ring-2 ring-primary',
      )}
    >
      <Badge variant={urgent ? 'destructive' : 'secondary'}>{KIND_LABEL[item.kind]}</Badge>
      <span data-reason className="min-w-0 flex-1 truncate">
        {item.reason}
      </span>
      {item.ticket ? <Badge variant="outline">{item.ticket}</Badge> : null}
      <span className="text-xs tabular-nums text-muted-foreground" title={item.createdAt}>
        {formatDuration(now - Date.parse(item.createdAt))}
      </span>
      {item.snoozeUntil ? (
        <span className="text-xs text-muted-foreground">
          {`until ${new Date(item.snoozeUntil).toLocaleString()}`}
        </span>
      ) : null}
      {sessionRef(item) ? (
        <Button size="sm" variant="outline" onClick={props.onOpen}>
          Open
        </Button>
      ) : null}
      {pty ? (
        <Button size="sm" onClick={() => props.onTerminal(pty)}>
          Terminal
        </Button>
      ) : null}
      {triageable ? (
        <>
          <Button size="sm" variant="ghost" onClick={props.onDone}>
            Done
          </Button>
          <NativeSelect
            aria-label="Snooze"
            className="h-7 text-xs"
            value=""
            onChange={(e) => {
              if (e.target.value) props.onSnooze(e.target.value);
            }}
          >
            <option value="">Snooze…</option>
            {snoozePresets(new Date(now)).map((p) => (
              <option key={p.label} value={p.until}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={props.onReopen}>
          Reopen
        </Button>
      )}
    </li>
  );
}
