import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary',
        className,
      )}
      {...rest}
    />
  );
}
