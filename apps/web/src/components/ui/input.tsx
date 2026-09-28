import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

/** shared with `NativeSelect`, so a select sits flush beside an input */
export const inputClassName =
  'h-8 min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

/** Stock shadcn input minus `w-full`: the app sizes its inputs at each call site. */
export function Input({ className, type, ...rest }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...rest} />;
}
