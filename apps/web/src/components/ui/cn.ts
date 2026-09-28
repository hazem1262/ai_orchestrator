/**
 * shadcn/ui primitives, copied into this repo and owned by it (MIT).
 *
 * Every feature imports UI primitives from `@/components/ui/*` and never from a vendor path, so
 * swapping to a different kit later touches only this folder. There is no private package and no
 * registry auth involved: `pnpm install` works on a clean machine with no tokens.
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class values and lets a later Tailwind class override an earlier one it conflicts with. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
