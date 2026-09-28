import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import { usePinSession } from '@/api/queries/sessions.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Snippet } from './Snippet.tsx';

export const AVAILABILITY_VARIANT: Record<SessionListItem['availability'], BadgeVariant> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'outline',
  remote: 'secondary',
};

export const titleOf = (item: SessionListItem) => item.name ?? item.firstPrompt ?? item.id;

/** Star toggle; pinned rows sort first (server-side). */
export function PinButton({ item }: { item: SessionListItem }) {
  const pin = usePinSession();
  const title = titleOf(item);
  const label = item.pinned ? `Unpin ${title}` : `Pin ${title}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={item.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={item.pinned}
          onClick={() => pin.mutate({ source: item.source, id: item.id, pinned: !item.pinned })}
        >
          <Star className={cn(item.pinned ? 'fill-current text-warning' : 'text-muted-foreground')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SessionTitle({ item, className }: { item: SessionListItem; className?: string }) {
  const title = titleOf(item);
  return (
    <Link
      to="/sessions/$source/$id"
      params={{ source: item.source, id: item.id }}
      title={title}
      className={cn('font-medium hover:underline', className)}
    >
      {title}
    </Link>
  );
}

/** The search snippet wins when the row matched on text; otherwise the recap or last/first prompt. */
export function SessionSecondary({ item, className }: { item: SessionListItem; className?: string }) {
  const title = titleOf(item);
  const secondary =
    item.recap ?? (item.lastPrompt && item.lastPrompt !== title ? item.lastPrompt : item.firstPrompt);
  return (
    <span className={cn('truncate text-xs text-muted-foreground', className)}>
      {item.snippet ? <Snippet text={item.snippet} /> : (secondary ?? '')}
    </span>
  );
}

/** Availability, source (when not Claude), live state, tickets, PRs and labels. */
export function Chips({ item, max = 2 }: { item: SessionListItem; max?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1 overflow-hidden">
      <Badge variant={AVAILABILITY_VARIANT[item.availability]}>{item.availability}</Badge>
      {item.source !== 'claude' ? <Badge variant="secondary">{item.source}</Badge> : null}
      {item.live ? (
        <Badge variant="warning">{item.live.ownership === 'owned' ? 'open' : item.live.status}</Badge>
      ) : null}
      {item.tickets.slice(0, max).map((t) => (
        <Badge key={t} variant="outline">
          {t}
        </Badge>
      ))}
      {item.prs.slice(0, max).map((pr) => (
        <a
          key={pr.url}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
        >
          #{pr.number}
        </a>
      ))}
      {item.labels
        .filter((l) => l !== HIDDEN_LABEL)
        .map((l) => (
          <Badge key={l} variant="secondary">
            {l}
          </Badge>
        ))}
    </div>
  );
}
