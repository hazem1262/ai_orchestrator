import { Link } from '@tanstack/react-router';
import { Check, Clock, MoreHorizontal, RotateCcw, ThumbsUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { formatDuration } from '@/features/live-board/sort.ts';
import { InboxItemActions } from './InboxItemActions.tsx';
import { DuplicateCount, KindBadge } from './KindBadge.tsx';
import { hasDetail, type InboxGroup, isTriageable, kindMeta, sessionRef } from './kinds.ts';
import { SnoozeMenu } from './RowActions.tsx';
import { snoozePresets } from './snooze.ts';
import type { InboxTriage } from './useInboxTriage.ts';

/** One inbox row at phone width: a card with thumb-sized triage buttons. */
export function InboxCard({
  group,
  now,
  selected,
  triage,
  onSelect,
}: {
  group: InboxGroup;
  now: number;
  selected: boolean;
  triage: InboxTriage;
  onSelect(): void;
}) {
  const item = group.lead;
  const ref = sessionRef(item);
  const { label } = kindMeta(item);
  const hour = snoozePresets(new Date(now))[0];

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: selection by keyboard is handled by useInboxKeys
    <article
      aria-label={`${label}: ${item.reason}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <Card className={cn('flex flex-col gap-2 p-3', selected && 'bg-accent/60')}>
        <header className="flex min-w-0 items-center gap-2">
          <KindBadge item={item} />
          {item.ticket ? (
            <Badge variant="outline" className="min-w-0 truncate font-mono">
              {item.ticket}
            </Badge>
          ) : null}
          <DuplicateCount count={group.items.length} />
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {formatDuration(now - Date.parse(item.createdAt))}
          </span>
        </header>
        <p className="font-medium break-words">{item.reason}</p>
        {item.snoozeUntil ? (
          <p className="text-xs text-muted-foreground">{`until ${new Date(item.snoozeUntil).toLocaleString()}`}</p>
        ) : null}
        {selected && hasDetail(item) ? <InboxItemActions item={item} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          {isTriageable(item) ? (
            <>
              {item.kind === 'plan_approval' ? null : (
                <Button disabled={triage.busy} onClick={() => triage.approve(group)}>
                  <ThumbsUp />
                  Approve
                </Button>
              )}
              <Button variant="outline" disabled={triage.busy} onClick={() => triage.done(group)}>
                <Check />
                Done
              </Button>
              {hour ? (
                <Button
                  variant="outline"
                  disabled={triage.busy}
                  onClick={() => triage.snooze(group, hour.until, hour.label)}
                >
                  <Clock />
                  Snooze 1h
                </Button>
              ) : null}
              <SnoozeMenu group={group} now={now} triage={triage} presets={(all) => all.slice(1)}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More snooze options">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </SnoozeMenu>
            </>
          ) : (
            <Button variant="outline" disabled={triage.busy} onClick={() => triage.reopen(group)}>
              <RotateCcw />
              Reopen
            </Button>
          )}
          {ref ? (
            <Link to="/sessions/$source/$id" params={ref} className="ml-auto text-sm text-primary underline">
              Open session to reply
            </Link>
          ) : null}
        </div>
      </Card>
    </article>
  );
}
