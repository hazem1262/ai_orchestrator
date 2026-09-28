import type { SessionListItem } from '@orc/api-contract';
import { Card } from '@/components/ui/card.tsx';
import { formatCost, formatDateTime, formatDuration } from '@/lib/format.ts';
import { Chips, PinButton, SessionSecondary, SessionTitle } from './parts.tsx';
import { RowActions } from './RowActions.tsx';

/** Phone layout: one card per session, the title gets the full row width (audit F8). */
export function SessionCards({ items }: { items: SessionListItem[] }) {
  return (
    <section aria-label="Sessions" className="flex flex-col gap-2">
      {items.map((item) => (
        <Card key={item.pk} className="gap-2 p-3">
          <div className="flex min-w-0 items-start gap-1">
            <div className="min-w-0 flex-1">
              <SessionTitle item={item} className="line-clamp-2 break-words" />
              <SessionSecondary item={item} className="line-clamp-2 block" />
            </div>
            <PinButton item={item} />
          </div>
          <Chips item={item} max={1} />
          <div className="flex items-center gap-2">
            <p
              className="min-w-0 truncate font-mono text-xs text-muted-foreground tabular-nums"
              title={formatDateTime(item.lastActivityAt)}
            >
              {formatDateTime(item.lastActivityAt)} · {formatDuration(item.durationMs)} ·{' '}
              {formatCost(item.costUsd)}
            </p>
            <div className="ml-auto shrink-0">
              <RowActions item={item} />
            </div>
          </div>
        </Card>
      ))}
    </section>
  );
}
