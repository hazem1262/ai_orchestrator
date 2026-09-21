/**
 * shadcn/ui primitives, copied into this repo and owned by it (MIT).
 *
 * Every feature imports UI primitives from `@/components/ui/*` and never from a vendor path, so
 * swapping to a different kit later touches only this folder. There is no private package and no
 * registry auth involved: `pnpm install` works on a clean machine with no tokens.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
