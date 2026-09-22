import type { InboxItem } from '@orc/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { createInboxEngine, type InboxEngineRuntime } from '../../inbox/engine.ts';
import { registerInboxRoutes } from './inbox.ts';

const homes = useTempHomes();
let ctx: TestContext;
let engine: InboxEngineRuntime;
let app: Hono;
let id: string;
let otherId: string;

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getList = async (qs = '') => (await (await app.request(`/api/inbox${qs}`)).json()) as InboxItem[];
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  ctx = createTestContext({ homes });
  engine = createInboxEngine(ctx);
  ctx.inbox = engine;
  id = engine.upsert({
    kind: 'waiting',
    scope: { session: 'claude:a' },
    projectId: 'wakecap',
    reason: 'r',
  }).id;
  otherId = engine.upsert({
    kind: 'error',
    scope: { session: 'claude:b' },
    projectId: 'forza',
    reason: 'r',
  }).id;
  app = new Hono();
  registerInboxRoutes(app, ctx);
});

afterEach(() => {
  engine.stop();
  ctx.dispose();
});

describe('GET /api/inbox', () => {
  it('lists every item without filters', async () => {
    expect((await getList()).map((i) => i.id).sort()).toEqual([id, otherId].sort());
  });

  it('applies comma-separated state and kind filters plus projectId', async () => {
    expect((await getList('?state=open,snoozed&kind=waiting&projectId=wakecap')).map((i) => i.id)).toEqual([
      id,
    ]);
    expect((await getList('?kind=waiting,error')).map((i) => i.id).sort()).toEqual([id, otherId].sort());
    expect((await getList('?projectId=forza')).map((i) => i.id)).toEqual([otherId]);
    engine.markDone(id);
    expect((await getList('?state=open')).map((i) => i.id)).toEqual([otherId]);
    expect((await getList('?state=done')).map((i) => i.id)).toEqual([id]);
  });

  it('rejects an unknown state or kind with validation_failed', async () => {
    const badState = await app.request('/api/inbox?state=bogus');
    expect(badState.status).toBe(400);
    expect(await errorCode(badState)).toBe('validation_failed');
    const badKind = await app.request('/api/inbox?kind=nope');
    expect(badKind.status).toBe(400);
    expect(await errorCode(badKind)).toBe('validation_failed');
  });
});

describe('POST /api/inbox/:id/:action', () => {
  it('marks done, reopens and snoozes, returning the updated item', async () => {
    const done = await post(`/api/inbox/${id}/done`, {});
    expect(done.status).toBe(200);
    expect(((await done.json()) as InboxItem).state).toBe('done');
    expect(engine.list({ state: ['done'] }).map((i) => i.id)).toEqual([id]);

    const reopened = await post(`/api/inbox/${id}/reopen`, {});
    expect(((await reopened.json()) as InboxItem).state).toBe('open');

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozed = await post(`/api/inbox/${id}/snooze`, { until });
    expect(await snoozed.json()).toMatchObject({ id, state: 'snoozed', snoozeUntil: until });
    expect(engine.list({ state: ['snoozed'] }).map((i) => i.id)).toEqual([id]);
  });

  it('acts only on the addressed item', async () => {
    await post(`/api/inbox/${id}/done`, {});
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([otherId]);
  });

  it('accepts done and reopen with no body at all', async () => {
    const done = await post(`/api/inbox/${id}/done`);
    expect(done.status).toBe(200);
    expect(((await done.json()) as InboxItem).state).toBe('done');
    const reopened = await post(`/api/inbox/${id}/reopen`);
    expect(((await reopened.json()) as InboxItem).state).toBe('open');
  });

  it('rejects a snooze without until, with a past until, or with unknown body keys', async () => {
    const missing = await post(`/api/inbox/${id}/snooze`, {});
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('validation_failed');

    const past = await post(`/api/inbox/${id}/snooze`, { until: '2000-01-01T00:00:00.000Z' });
    expect(past.status).toBe(400);
    expect(await errorCode(past)).toBe('validation_failed');

    const extra = await post(`/api/inbox/${id}/snooze`, {
      until: new Date(Date.now() + 60_000).toISOString(),
      x: 1,
    });
    expect(extra.status).toBe(400);
    expect(await errorCode(extra)).toBe('validation_failed');

    expect(
      engine
        .list({ state: ['open'] })
        .map((i) => i.id)
        .sort(),
    ).toEqual([id, otherId].sort());
  });

  it('returns not_found for an unknown id on every action', async () => {
    for (const action of ['done', 'reopen', 'snooze'] as const) {
      const body = action === 'snooze' ? { until: new Date(Date.now() + 60_000).toISOString() } : {};
      const res = await post(`/api/inbox/nope/${action}`, body);
      expect(res.status, action).toBe(404);
      expect(await errorCode(res), action).toBe('not_found');
    }
  });

  it('does not route an unknown action', async () => {
    expect((await post(`/api/inbox/${id}/explode`, {})).status).toBe(404);
    expect(
      engine
        .list({ state: ['open'] })
        .map((i) => i.id)
        .sort(),
    ).toEqual([id, otherId].sort());
  });
});

describe('secret redaction on the way out', () => {
  const SECRET = 'hunter2';
  let secretId: string;

  beforeEach(() => {
    secretId = engine.upsert({
      kind: 'tests_red',
      scope: { session: 'claude:c' },
      projectId: 'wakecap',
      ticket: 'PGPASSWORD=hunter2',
      reason: 'r',
      payload: { command: 'PGPASSWORD=hunter2 pnpm test' },
    }).id;
    // The store keeps the raw payload; only the route boundary redacts it.
    expect(JSON.stringify(engine.list({ kind: ['tests_red'] }))).toContain(SECRET);
  });

  it('redacts every listed item', async () => {
    const res = await app.request('/api/inbox');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain(secretId);
    expect(text).not.toContain(SECRET);
  });

  it('redacts the item returned by every action', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    for (const [action, body] of [
      ['done', {}],
      ['reopen', {}],
      ['snooze', { until }],
    ] as const) {
      const res = await post(`/api/inbox/${secretId}/${action}`, body);
      const text = await res.text();
      expect(res.status, action).toBe(200);
      expect(text, action).toContain(secretId);
      expect(text, action).not.toContain(SECRET);
    }
  });

  it('redacts error bodies that echo the request', async () => {
    const notFound = await post('/api/inbox/PGPASSWORD=hunter2/done', {});
    expect(notFound.status).toBe(404);
    const notFoundText = await notFound.text();
    expect(notFoundText).toContain('not_found');
    expect(notFoundText).not.toContain(SECRET);

    const badKey = await post(`/api/inbox/${secretId}/done`, { 'PGPASSWORD=hunter2': 1 });
    expect(badKey.status).toBe(400);
    const badKeyText = await badKey.text();
    expect(badKeyText).toContain('validation_failed');
    expect(badKeyText).not.toContain(SECRET);
  });
});

describe('malformed request body', () => {
  it('rejects a body that is not JSON with validation_failed and leaves the item alone', async () => {
    for (const action of ['done', 'reopen', 'snooze'] as const) {
      const res = await app.request(`/api/inbox/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status, action).toBe(400);
      expect(((await res.json()) as { error: { code: string; message: string } }).error, action).toEqual(
        expect.objectContaining({ code: 'validation_failed', message: 'request body must be JSON' }),
      );
    }
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toContain(id);
  });
});
