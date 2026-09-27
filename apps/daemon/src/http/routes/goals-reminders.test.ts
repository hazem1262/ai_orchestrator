import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createGoalService } from '../../services/goals/goals.ts';
import { createReminderService } from '../../services/reminders/reminders.ts';
import { createScheduler } from '../../services/scheduler/scheduler.ts';
import { NON_ACTION_ROUTES } from '../audit-middleware.ts';
import { registerGoalRoutes } from './goals.ts';
import { registerReminderRoutes } from './reminders.ts';

// A GitHub token shape that core `redact` masks. The goal prefill is built from the session's
// first prompt, which is transcript-derived, so it leaves the daemon through redactedJson.
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function setup() {
  const t = makeP5Context({
    config: withWakecap('/Users/test/Wakecap'),
    data: {
      sessions: [
        makeSession({ id: 's1', firstPrompt: 'do the thing' }),
        makeSession({ id: 'leak', firstPrompt: `push with ${SECRET}` }),
      ],
    },
  });
  t.ctx.goals = createGoalService(t.ctx);
  t.ctx.reminders = createReminderService(t.ctx, {
    scheduler: createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) }),
  });
  const app = bareApp();
  registerGoalRoutes(app, t.ctx);
  registerReminderRoutes(app, t.ctx);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, send };
}

describe('/api/goals', () => {
  it('returns prefill, saves and lists goals', async () => {
    const { app, send } = setup();
    expect(await (await app.request('/api/goals/session/claude%3As1')).json()).toEqual({
      goal: null,
      prefill: 'do the thing',
    });
    const put = await send('PUT', '/api/goals/session/claude%3As1', {
      objective: 'finish',
      state: 'blocked',
      blockedReason: 'waiting on QA',
    });
    expect(await put.json()).toMatchObject({
      targetId: 'claude:s1',
      state: 'blocked',
      blockedReason: 'waiting on QA',
    });
    expect(((await (await app.request('/api/goals?state=blocked,bogus')).json()) as unknown[]).length).toBe(
      1,
    );
    expect((await send('PUT', '/api/goals/bogus/x', { objective: 'a', state: 'active' })).status).toBe(400);
    expect((await send('PUT', '/api/goals/stream/SAF-1', { objective: '', state: 'active' })).status).toBe(
      400,
    );
  });

  it('redacts the transcript-derived prefill on the way out', async () => {
    const { app } = setup();
    const res = await app.request('/api/goals/session/claude%3Aleak');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('push with');
    expect(text).not.toContain(SECRET);
  });
});

describe('/api/reminders', () => {
  it('creates, lists and cancels reminders', async () => {
    const { app, send } = setup();
    const res = await send('POST', '/api/reminders', {
      sessionPk: 'claude:s1',
      text: 're-check CI',
      inMinutes: 20,
      sendToSession: true,
    });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { id: string; state: string };
    expect(r.state).toBe('pending');
    expect(
      ((await (await app.request('/api/reminders?state=pending&sessionPk=claude%3As1')).json()) as unknown[])
        .length,
    ).toBe(1);
    expect(await (await send('POST', `/api/reminders/${r.id}/cancel`, {})).json()).toMatchObject({
      state: 'cancelled',
    });
    expect((await send('POST', '/api/reminders/nope/cancel', {})).status).toBe(404);
    expect(
      (await send('POST', '/api/reminders', { text: 'x', sendToSession: true, inMinutes: 5 })).status,
    ).toBe(400);
    expect(
      (await send('POST', '/api/reminders', { text: 'x', dueAt: '2020-01-01T00:00:00.000Z' })).status,
    ).toBe(400);
  });
});

describe('/api/goals and /api/reminders in the real app', () => {
  // Plan Task 14 Step 8: every write route is audit-exempt (NON_ACTION_ROUTES) — goals are local
  // metadata, and a reminder's PTY input is audited by withPtyInputAudit when it fires.
  const WRITES = [
    ['PUT', '/api/goals/:targetType/:targetId'],
    ['POST', '/api/reminders'],
    ['POST', '/api/reminders/:id/cancel'],
  ] as const;

  it('are registered by registerAllRoutes and every write route is audit-exempt', async () => {
    const t = await createP3Harness();
    try {
      const registered = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const r of [
        'GET /api/goals',
        'GET /api/goals/:targetType/:targetId',
        'GET /api/reminders',
        ...WRITES.map(([m, p]) => `${m} ${p}`),
      ]) {
        expect(registered).toContain(r);
      }
      for (const [method, path] of WRITES) {
        expect(NON_ACTION_ROUTES.some((n) => n.method === method && n.path === path)).toBe(true);
      }
    } finally {
      await t.cleanup();
    }
  });
});
