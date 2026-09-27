import type { Handoff } from '@orc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { ServiceError } from '../../services/errors.ts';
import type { HandoffService } from '../../services/handoff/handoff.ts';
import { LaunchError } from '../../services/launch.ts';
import { matchAuditedRoute, NON_ACTION_ROUTES } from '../audit-middleware.ts';
import { registerHandoffRoutes } from './handoffs.ts';

// Safety: the route tests use a fake HandoffService (no recap engine, no launcher), and the
// real-app block only inspects the registered route table and the audit lists — it sends no
// request that could reach an engine or start a session.
// ANTHROPIC_API_KEY is removed from the process for the whole file.
let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});

// A GitHub token shape that core `redact` masks. Handoff text is model output over a transcript
// digest, so every body that carries it leaves the daemon redacted.
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const h: Handoff = {
  id: 'h1',
  sessionId: 'claude:s1',
  status: 'in_progress',
  summary: 's',
  evidence: [],
  files: [],
  nextSteps: [],
  blockers: [],
  links: [],
  createdAt: 't',
};
const leak: Handoff = { ...h, id: 'leak', sessionId: 'claude:leak', summary: `push with ${SECRET}` };

function setup(launchErr?: Error) {
  const svc: HandoffService = {
    generate: async (pk) =>
      pk === 'claude:s1'
        ? h
        : pk === 'claude:leak'
          ? leak
          : Promise.reject(new ServiceError('not_found', 404, 'session not found')),
    toMarkdown: (x) => (x.id === 'leak' ? `# md ${SECRET}` : '# md'),
    latest: (pk) => (pk === 'claude:s1' ? h : pk === 'claude:leak' ? leak : null),
    get: (id) => (id === 'h1' ? h : id === 'leak' ? leak : null),
    resumeFresh: async () => {
      if (launchErr) throw launchErr;
      return { ptyId: 'p1' };
    },
  };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.handoffs = svc;
  const app = bareApp();
  registerHandoffRoutes(app, ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post };
}

describe('/api/handoffs', () => {
  it('generates, reads and exports handoffs', async () => {
    const { app, post } = setup();
    expect(await (await post('/api/handoffs/session/claude/s1', {})).json()).toEqual(h);
    expect((await post('/api/handoffs/session/claude/zz', {})).status).toBe(404);
    expect(await (await app.request('/api/handoffs/session/claude/s1')).json()).toEqual({
      handoff: h,
      markdown: '# md',
    });
    expect(await (await app.request('/api/handoffs/session/claude/zz')).json()).toBeNull();
    const md = await app.request('/api/handoffs/h1/markdown');
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('content-disposition')).toBe('attachment; filename="handoff-h1.md"');
    expect(await md.text()).toBe('# md');
    expect((await app.request('/api/handoffs/zz/markdown')).status).toBe(404);
  });

  it('requires confirmation to resume fresh and maps launch errors', async () => {
    const { post } = setup();
    const need = await post('/api/handoffs/h1/resume-fresh', {});
    expect(need.status).toBe(409);
    expect(await need.json()).toMatchObject({
      error: {
        code: 'confirmation_required',
        details: { summary: { handoffId: 'h1', sessionPk: 'claude:s1' } },
      },
    });
    expect(await (await post('/api/handoffs/h1/resume-fresh', { confirm: true })).json()).toEqual({
      ptyId: 'p1',
    });
    expect((await post('/api/handoffs/zz/resume-fresh', { confirm: true })).status).toBe(404);
    const capped = setup(new LaunchError(429, 'concurrency_limit', 'too many sessions', { max: 6 }));
    const res = await capped.post('/api/handoffs/h1/resume-fresh', { confirm: true });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'concurrency_limit' } });
  });

  it('redacts handoff text on the way out', async () => {
    const { app, post } = setup();
    const generated = await (await post('/api/handoffs/session/claude/leak', {})).text();
    expect(generated).toContain('push with');
    expect(generated).not.toContain(SECRET);
    const latest = await (await app.request('/api/handoffs/session/claude/leak')).text();
    expect(latest).toContain('push with');
    expect(latest).not.toContain(SECRET);
    const md = await (await app.request('/api/handoffs/leak/markdown')).text();
    expect(md).toContain('# md');
    expect(md).not.toContain(SECRET);
    const confirm = await (await post('/api/handoffs/leak/resume-fresh', {})).text();
    expect(confirm).not.toContain(SECRET);
  });
});

describe('/api/handoffs in the real app', () => {
  it('are registered by registerAllRoutes', async () => {
    const t = await createP3Harness();
    try {
      const registered = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const r of [
        'POST /api/handoffs/session/:source/:id',
        'GET /api/handoffs/session/:source/:id',
        'GET /api/handoffs/:id/markdown',
        'POST /api/handoffs/:id/resume-fresh',
      ]) {
        expect(registered).toContain(r);
      }
    } finally {
      await t.cleanup();
    }
  });

  it('audits resume-fresh as session.launch and exempts generate', () => {
    // Plan Task 15 Step 7: resume-fresh starts a session, so it is audited like POST /api/sessions/launch.
    const hit = matchAuditedRoute('POST', '/api/handoffs/h%201/resume-fresh');
    expect(hit?.route.action).toBe('session.launch');
    expect(hit?.route.target(hit.m, {})).toBe('handoff:h 1');
    expect(
      NON_ACTION_ROUTES.some((n) => n.method === 'POST' && n.path === '/api/handoffs/session/:source/:id'),
    ).toBe(true);
  });
});
