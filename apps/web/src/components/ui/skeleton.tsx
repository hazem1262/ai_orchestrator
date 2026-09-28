import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Skeleton({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-muted', className)} {...rest} />
  );
}
