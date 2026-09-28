import type { LiveStatus, Source } from '@orc/core';
import { Badge } from '@/components/ui/badge.tsx';
import { cn } from '@/components/ui/cn.ts';
import { STATUS_LABEL } from './sort.ts';

/** Status tone: one place maps a live status to the semantic status tokens. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const SOFT: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

/** Left edge drawn on a card that needs a human. */
export const EDGE: Record<Tone, string> = {
  neutral: '',
  info: '',
  success: 'shadow-[inset_3px_0_0_var(--success)]',
  warning: 'shadow-[inset_3px_0_0_var(--warning)]',
  danger: 'shadow-[inset_3px_0_0_var(--destructive)]',
};

export const STATUS_TONE: Record<LiveStatus, Tone> = {
  waiting: 'warning',
  review: 'success',
  blocked: 'warning',
  error: 'danger',
  busy: 'info',
  shell: 'neutral',
  idle: 'neutral',
  ended: 'neutral',
};

export const SOURCE_LABEL: Record<Source, string> = { claude: 'Claude', codex: 'Codex', agnc: 'AGNC' };

export function StatusBadge({ status }: { status: LiveStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <Badge variant="secondary" className={cn('gap-1.5', SOFT[tone])}>
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', DOT[tone], status === 'busy' && 'animate-pulse')}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: Source }) {
  return (
    <Badge variant="outline" className="font-mono">
      {SOURCE_LABEL[source]}
    </Badge>
  );
}
