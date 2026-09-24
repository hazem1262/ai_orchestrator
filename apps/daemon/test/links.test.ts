import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerLinksRoutes } from '../src/http/routes/links.ts';
import { createPlanFinderFromContext, findRepoRoot } from '../src/services/links/plans.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';

let t: P3Harness;
let app: Hono<{ Bindings: HttpBindings }>;
let home: string;
let planRoot: string;
let repo: string;

beforeAll(async () => {
  t = await createP3Harness();
  home = mkdtempSync(join(tmpdir(), 'orc-links-home-'));
  planRoot = join(home, 'Wakecap/plans');
  mkdirSync(join(planRoot, '2026'), { recursive: true });
  writeFileSync(join(planRoot, '2026/SAF-1787-sla.md'), '# SLA weekends plan\nUse token=abc for nothing.\n');
  writeFileSync(join(planRoot, 'other.md'), '# Unrelated\n');
  repo = join(home, 'Wakecap/Backend/svc');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(
    join(repo, 'docs/superpowers/plans/2026-09-01-weekends.md'),
    '# Weekends\nTicket: SAF-1787\n',
  );
  const cfg = OrcConfig.parse({ links: { planRoots: [planRoot], linearWorkspace: 'acme' } });
  app = new Hono<{ Bindings: HttpBindings }>();
  registerLinksRoutes(app, { ...t.ctx, config: () => cfg }, { home });
});
afterAll(async () => {
  await t.cleanup();
});

const get = (path: string) => app.request(path);

describe('GET /api/sessions/:source/:id/links', () => {
  it('returns PRs, ticket URLs and ticket-matched plans', async () => {
    const res = await get('/api/sessions/claude/s-prlink/links');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prs: Array<{ number: number }>;
      tickets: Array<{ id: string; url: string | null }>;
      plans: Array<{ title: string; source: string; reason: string }>;
    };
    expect(body.prs.map((p) => p.number)).toEqual([231]);
    expect(body.tickets).toContainEqual({ id: 'SAF-1787', url: 'https://linear.app/acme/issue/SAF-1787' });
    expect(body.plans.map((p) => [p.source, p.reason, p.title]).sort()).toEqual([
      ['claude-plans', 'ticket', 'Plan: SAF-1787 exclude weekends'],
      ['wakecap-plans', 'ticket', 'SLA weekends plan'],
    ]);
  });

  it('returns artifacts and the bridge session from transcript meta', async () => {
    const body = (await (await get('/api/sessions/claude/s-unknown/links')).json()) as {
      artifacts: unknown[];
      bridgeSessionId: string | null;
    };
    expect(body.artifacts).toEqual([
      { title: 'Artifact', url: 'https://example.test/a', path: '/tmp/x.html' },
    ]);
    expect(body.bridgeSessionId).toBe('b-1');
  });

  it('404s for unknown sessions', async () => {
    expect((await get('/api/sessions/claude/nope/links')).status).toBe(404);
  });
});

describe('repo docs', () => {
  it('finds the repo root under home and matches its superpowers plans', async () => {
    expect(findRepoRoot(join(repo, 'src/deep'), home)).toBe(repo);
    expect(findRepoRoot('/definitely/not/home', home)).toBeNull();
    const cfg = OrcConfig.parse({ links: { planRoots: [] } });
    const finder = createPlanFinderFromContext({ paths: t.ctx.paths, config: () => cfg }, home);
    const base = t.ctx.sessions.get('claude', 's-prlink');
    if (!base) throw new Error('fixture s-prlink missing');
    const refs = await finder.forSession({ ...base, cwds: [join(repo, 'src')], tickets: ['SAF-1787'] });
    expect(refs.map((r) => r.source)).toContain('repo-docs');
  });
});

describe('plans routes', () => {
  it('searches by title and ticket', async () => {
    const byTitle = (await (await get('/api/plans?q=sla')).json()) as Array<{
      title: string;
      reason: string;
    }>;
    expect(byTitle.map((p) => p.title)).toEqual(['SLA weekends plan']);
    expect(byTitle[0]?.reason).toBe('query');
    const byTicket = (await (await get('/api/plans?q=SAF-1787')).json()) as unknown[];
    expect(byTicket.length).toBeGreaterThanOrEqual(2);
  });

  it('serves plan content from allowed roots only, redacted', async () => {
    const ok = await get(
      `/api/plans/content?path=${encodeURIComponent(join(planRoot, '2026/SAF-1787-sla.md'))}`,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { text: string };
    expect(body.text).toContain('token=«redacted:secret»');
    expect((await get('/api/plans/content?path=%2Fetc%2Fpasswd')).status).toBe(403);
    expect(
      (await get(`/api/plans/content?path=${encodeURIComponent(`${planRoot}/../../secret.md`)}`)).status,
    ).toBe(403);
    expect(
      (await get(`/api/plans/content?path=${encodeURIComponent(join(planRoot, 'missing.md'))}`)).status,
    ).toBe(404);
    expect((await get('/api/plans/content')).status).toBe(400);
  });
});
