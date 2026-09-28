import type { ComponentProps } from 'react';
import { cn } from './cn.ts';
import { inputClassName } from './input.tsx';

/** A native `<select>` styled like `Input`. */
export function NativeSelect({ className, ...rest }: ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn(inputClassName, 'pr-1.5', className)} {...rest} />;
}
