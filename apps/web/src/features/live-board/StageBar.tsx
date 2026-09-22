import type { Stage } from '@orc/core';
import { cn } from '@/components/ui/cn.ts';

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'understand', label: 'Understand' },
  { id: 'modify', label: 'Modify' },
  { id: 'test', label: 'Test' },
  { id: 'review', label: 'Review' },
];

export function StageBar({ stage }: { stage: Stage | null }) {
  const current = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  return (
    <ol aria-label="Stage" className="flex gap-0.5 text-[10px]">
      {STAGES.map((s, i) => (
        <li
          key={s.id}
          aria-current={i === current ? 'step' : undefined}
          className={cn(
            'flex-1 rounded px-1 text-center',
            i < current && 'bg-success/40',
            i === current && 'bg-success text-primary-foreground',
            i > current && 'bg-muted text-muted-foreground',
          )}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}
