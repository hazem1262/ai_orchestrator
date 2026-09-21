import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'checked' | 'onChange'> {
  checked?: boolean;
  onCheckedChange?(checked: boolean): void;
}

export function Checkbox({ checked, onCheckedChange, className, ...rest }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className={cn('h-4 w-4 accent-primary', className)}
      {...rest}
    />
  );
}
