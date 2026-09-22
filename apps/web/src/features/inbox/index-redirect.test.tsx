import { describe, expect, it } from 'vitest';
import { Route } from '../../routes/index.tsx';

/** TanStack's `redirect()` returns a `Response` carrying the navigation options on `.options`. */
function thrownRedirect(fn: () => unknown): { to?: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    return ((e as Response & { options?: { to?: string } }).options ?? {}) as { to?: string };
  }
  throw new Error('beforeLoad did not redirect');
}

describe('/ route', () => {
  it('redirects to /inbox', () => {
    const beforeLoad = Route.options.beforeLoad as unknown as (ctx: unknown) => unknown;
    expect(beforeLoad).toBeTypeOf('function');
    expect(thrownRedirect(() => beforeLoad({})).to).toBe('/inbox');
  });
});
