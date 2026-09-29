import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn.ts';

/**
 * One settings panel: a hairline card whose `h2` is the panel's heading. It stays a `<section>`
 * with an accessible name, so every panel is a named region.
 */
export function SettingsCard({
  label,
  title,
  titleId,
  description,
  children,
  className,
}: {
  /** The region's accessible name. Omitted when `titleId` names it instead. */
  label?: string;
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={titleId ? undefined : label}
      aria-labelledby={titleId}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-sm text-card-foreground sm:p-5',
        className,
      )}
    >
      <header className="flex min-w-0 flex-col gap-1">
        <h2 id={titleId} className="text-base leading-snug font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </header>
      {children}
    </section>
  );
}
