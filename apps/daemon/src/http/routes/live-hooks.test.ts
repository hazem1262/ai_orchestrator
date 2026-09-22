import type { HttpBindings } from '@hono/node-server';
import type { LiveState, Session } from '@orc/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import type { BusEvent } from '../../live/event-bus.ts';
import { stubSession } from '../../live/stub-session.ts';
import type { OrcApp } from '../types.ts';
import { registerHookRoutes } from './hooks.ts';
import { registerLiveRoutes } from './live.ts';

const homes = useTempHomes();

const live: LiveState = {
  pid: 1,
  status: 'waiting',
  waitingFor: 'token=abc123',
  since: '2026-09-01T09:00:00.000Z',
  ownership: 'observed',
  ptyId: null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
};

const session = (id: string, projectId: string | null, lastPrompt: string): Session => ({
  ...stubSession({
    source: 'claude',
    id,
    cwd: '/Users/test/Wakecap',
    startedAt: '2026-09-01T09:00:00.000Z',
    projectId,
    name: id,
  }),
  lastPrompt,
  live,
});

let ctx: TestContext;
let app: OrcApp;
let fake: ReturnType<typeof createFakeLive>;

beforeEach(() => {
  ctx = createTestContext({ homes });
  fake = createFakeLive([
    session('a', 'wakecap', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please'),
    session('b', 'forza', 'hello'),
  ]);
  ctx.live = fake;
  app = new Hono<{ Bindings: HttpBindings }>();
  registerLiveRoutes(app, ctx);
  registerHookRoutes(app, ctx);
});
afterEach(() => ctx.dispose());

describe('GET /api/live', () => {
  it('returns live sessions, redacted, filtered by project', async () => {
    const res = await app.request('/api/live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body.map((s) => s.id)).toEqual(['a', 'b']);
    expect(body[0]?.lastPrompt).toBe('use «redacted:github» please');
    expect(body[0]?.live?.waitingFor).toBe('token=«redacted:secret»');
    const filtered = (await (await app.request('/api/live?projectId=forza')).json()) as Session[];
    expect(filtered.map((s) => s.id)).toEqual(['b']);
  });

  it('does not mutate the tracker’s own session objects while redacting', async () => {
    // The tracker keeps these objects and re-publishes them; redacting in place would make the
    // daemon's own state depend on whether an HTTP request happened to have been served.
    await app.request('/api/live');
    expect(fake.sessions[0]?.lastPrompt).toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(fake.sessions[0]?.live?.waitingFor).toBe('token=abc123');
  });

  it('returns an empty list before the tracker exists', async () => {
    ctx.live = undefined;
    expect(await (await app.request('/api/live')).json()).toEqual([]);
  });
});

describe('POST /api/hooks', () => {
  it('forwards a minimal event to the tracker and the bus', async () => {
    const seen: BusEvent[] = [];
    ctx.bus.on('hook.received', (e) => seen.push(e));
    const res = await app.request('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 's-basic',
        hook_event_name: 'Notification',
        message: 'needs you',
        prompt: 'SECRET PROMPT',
      }),
    });
    expect(res.status).toBe(200);
    expect(fake.hooks).toHaveLength(1);
    expect(fake.hooks[0]).toMatchObject({
      sessionId: 's-basic',
      event: 'Notification',
      message: 'needs you',
    });
    expect(seen).toEqual([
      { type: 'hook.received', payload: { sessionId: 's-basic', event: 'Notification' } },
    ]);
    expect(JSON.stringify(seen)).not.toContain('SECRET');
  });

  it('keeps only the four fields it declares, whatever else the payload carries', async () => {
    // HookIngestBody is deliberately loose, so every extra key Claude Code sends today or adds
    // tomorrow arrives in `parsed.data`. What stops it spreading is that the route names the
    // fields it copies rather than spreading the body — into the tracker, the bus and the log.
    const seen: BusEvent[] = [];
    ctx.bus.on('hook.received', (e) => seen.push(e));
    await app.request('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 's-extra',
        hook_event_name: 'Stop',
        prompt: 'SECRET PROMPT',
        tool_input: { command: 'psql PGPASSWORD=hunter2' },
        transcript_path: '/Users/test/.claude/projects/x/s-extra.jsonl',
      }),
    });
    expect(fake.hooks).toHaveLength(1);
    expect(Object.keys(fake.hooks[0] ?? {}).sort()).toEqual(['event', 'message', 'sessionId', 'ts']);
    const wire = JSON.stringify({ hooks: fake.hooks, bus: seen });
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('transcript');
  });

  it('rejects invalid payloads', async () => {
    const res = await app.request('/api/hooks', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('accepts a hook before the tracker exists', async () => {
    ctx.live = undefined;
    const res = await app.request('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-early', hook_event_name: 'Stop' }),
    });
    expect(res.status).toBe(200);
  });
});
