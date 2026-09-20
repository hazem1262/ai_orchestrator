import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'default' | 'sm' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-muted text-foreground hover:bg-border',
  outline: 'border bg-background hover:bg-muted',
  ghost: 'hover:bg-muted',
  destructive: 'bg-destructive text-primary-foreground hover:opacity-90',
};
const SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-3 text-sm',
  sm: 'h-7 px-2 text-xs',
  icon: 'h-7 w-7 text-sm',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-md font-medium transition disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
