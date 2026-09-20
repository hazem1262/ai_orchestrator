import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning';

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-muted text-foreground',
  outline: 'border text-foreground',
  destructive: 'bg-destructive text-primary-foreground',
  success: 'bg-success text-primary-foreground',
  warning: 'bg-warning text-foreground',
};

export interface BadgeProps extends ComponentProps<'span'> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'default', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
