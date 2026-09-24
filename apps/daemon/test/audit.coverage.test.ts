import { describe, expect, it } from 'vitest';
import { AUDITED_ROUTES, matchAuditedRoute, NON_ACTION_ROUTES } from '../src/http/audit-middleware.ts';
import { createP3Harness } from './p3-harness.ts';

const samplePath = (p: string) =>
  p.replace(/:([A-Za-z]+)(?:\{[^}]*\})?/g, (_m, name: string) => (name === 'source' ? 'claude' : 'x'));

describe('audit coverage (M3 exit: every app action appears in the audit log)', () => {
  it('every non-GET /api route is audited or explicitly exempt', async () => {
    const t = await createP3Harness();
    try {
      const missing = t.app.routes
        .filter((r) => r.path.startsWith('/api/') && !['ALL', 'GET', 'HEAD', 'OPTIONS'].includes(r.method))
        .filter(
          (r) =>
            !matchAuditedRoute(r.method, samplePath(r.path)) &&
            !NON_ACTION_ROUTES.some((n) => n.method === r.method && n.path === r.path),
        )
        .map((r) => `${r.method} ${r.path}`);
      expect([...new Set(missing)]).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it('uses <area>.<verb> action names', () => {
    for (const r of AUDITED_ROUTES) {
      const name = typeof r.action === 'string' ? r.action : r.action({});
      expect(name).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
