import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

/*
 * Calm cards: a hairline `border` and no shadow. Unlike stock shadcn, `Card` itself adds no padding
 * or gap — the header and content carry their own, and call sites that lay out a bare `Card` set
 * their padding directly.
 */
export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('rounded-xl border bg-card text-sm text-card-foreground', className)}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1 p-4', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('text-base leading-snug font-semibold tracking-tight', className)}
      {...rest}
    />
  );
}

export function CardDescription({ className, ...rest }: ComponentProps<'p'>) {
  return (
    <p data-slot="card-description" className={cn('text-sm text-muted-foreground', className)} {...rest} />
  );
}

export function CardContent({ className, ...rest }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('p-4 pt-0', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center rounded-b-xl border-t bg-muted/50 p-4', className)}
      {...rest}
    />
  );
}
