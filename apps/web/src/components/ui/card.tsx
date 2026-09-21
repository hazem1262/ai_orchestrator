import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-background', className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...rest} />;
}
