import type { Stage } from '@orc/core';
import { cn } from '@/components/ui/cn.ts';

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'understand', label: 'Understand' },
  { id: 'modify', label: 'Modify' },
  { id: 'test', label: 'Test' },
  { id: 'review', label: 'Review' },
];

/** Four-step progress: done steps tinted, the current step solid, later steps muted. */
export function StageBar({ stage }: { stage: Stage | null }) {
  const current = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  return (
    <ol aria-label="Stage" className="grid grid-cols-4 gap-1">
      {STAGES.map((s, i) => (
        <li key={s.id} aria-current={i === current ? 'step' : undefined} className="flex flex-col gap-1">
          <span
            aria-hidden
            className={cn(
              'h-1 rounded-full',
              i < current && 'bg-primary/45',
              i === current && 'bg-primary',
              i > current && 'bg-muted',
            )}
          />
          <span
            className={cn(
              'text-[0.6875rem] leading-none',
              i === current ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
