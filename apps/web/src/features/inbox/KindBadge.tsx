import type { InboxItem } from '@orc/core';
import { Badge } from '@/components/ui/badge.tsx';
import { cn } from '@/components/ui/cn.ts';
import { kindMeta, SOFT_TONE } from './kinds.ts';

export function KindBadge({ item }: { item: InboxItem }) {
  const { label, icon: Icon, tone } = kindMeta(item);
  return (
    <Badge variant="secondary" className={cn(SOFT_TONE[tone])}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** "×3" beside a row that stands for several identical items. */
export function DuplicateCount({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <Badge variant="outline" className="font-mono tabular-nums" aria-label={`${count} identical items`}>
      ×{count}
    </Badge>
  );
}
