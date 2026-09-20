import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestContext,
  FAKE_CLAUDE,
  indexFixtures,
  type TestContext,
  writeClaudeSession,
} from '../../test/helpers.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { resumeCommandLine } from './external.ts';
import { buildResumeCommand, decodeCursor, encodeCursor } from './sessions.ts';

const CODEX_1 = 'codex:c0dex000-0000-0000-0000-000000000001';

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('session service', () => {
  let ctx: TestContext;
  afterEach(() => ctx.dispose());

  async function setup(alive = false): Promise<TestContext> {
    ctx = createTestContext({ isPidAlive: () => alive });
    await indexFixtures(ctx);
    return ctx;
  }

  it('lists a project newest first with cursor paging', async () => {
    await setup();
    const all = ctx.sessions.list({ projectId: 'wakecap' });
    // The third codex fixture (SAF-1787-free, tool_search/web_search only) also resolves to
    // wakecap and is not automated, so it's a real 8th member of this project (see
    // indexer.test.ts's 'codex:...0003' assertion — it predates this task and isn't reimplemented).
    expect(all.items.map((i) => i.pk)).toEqual([
      'claude:s-subagents',
      'claude:s-unknown',
      'claude:s-drift',
      'claude:s-prlink',
      'codex:c0dex000-0000-0000-0000-000000000003',
      'claude:s-basic',
      CODEX_1,
      'claude:s-old-prompts-only',
    ]);
    expect(all.nextCursor).toBeNull();
    const basic = all.items.find((i) => i.pk === 'claude:s-basic');
    expect(basic).toMatchObject({
      name: 'Notification service test check',
      durationMs: 420_000,
      costUsd: 0.42,
      availability: 'resumable',
      pinned: false,
      labels: [],
      live: null,
      snippet: null,
    });

    const p1 = ctx.sessions.list({ projectId: 'wakecap', limit: 3 });
    expect(p1.items).toHaveLength(3);
    const p2 = ctx.sessions.list({ projectId: 'wakecap', limit: 3, cursor: p1.nextCursor ?? '' });
    const p3 = ctx.sessions.list({ projectId: 'wakecap', limit: 3, cursor: p2.nextCursor ?? '' });
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.pk)).toEqual(all.items.map((i) => i.pk));
    expect(p3.nextCursor).toBeNull();
    expect(() => ctx.sessions.list({ cursor: 'garbage' })).toThrow(/cursor/);
  });

  it('searches events, names and history with snippets', async () => {
    await setup();
    const n = ctx.sessions.list({ q: 'notification' });
    expect(n.items.map((i) => i.pk)).toEqual(['claude:s-basic']);
    expect(n.items[0]?.snippet).toContain('⟦notification⟧');

    const dec = ctx.sessions.list({ q: 'december' });
    expect(dec.items.map((i) => i.pk)).toEqual(['claude:s-old-prompts-only']);
    expect(dec.items[0]?.snippet).toBe('old session from ⟦december⟧');

    expect(ctx.sessions.list({ q: 'SAF-1787' }).items.map((i) => i.pk)).toEqual(['claude:s-prlink', CODEX_1]);
    expect(ctx.sessions.list({ q: 'zzzz-nothing' }).items).toEqual([]);
    expect(ctx.sessions.list({ q: 'weekends', projectId: 'forza' }).items).toEqual([]);
  });

  it('hides automated codex sessions unless asked', async () => {
    await setup();
    expect(ctx.sessions.list({ projectId: 'hackathon' }).items).toEqual([]);
    expect(ctx.sessions.list({ projectId: 'hackathon', includeAutomated: true }).items).toHaveLength(1);
  });

  it('gets sessions with observed liveness, events and agents', async () => {
    await setup(true);
    expect(ctx.sessions.get('claude', 's-basic')?.live).toMatchObject({
      pid: 41001,
      status: 'waiting',
      waitingFor: 'input needed',
      ownership: 'observed',
      ptyId: null,
    });
    expect(ctx.sessions.get('claude', 'nope')).toBeNull();
    expect(ctx.sessions.get('claude', 's-drift')?.live).toBeNull();
    const ev = ctx.sessions.events('claude', 's-basic', { limit: 4 });
    expect(ev.items).toHaveLength(4);
    expect(ev.nextSeq).toBe(4);
    expect(ctx.sessions.agents('claude', 's-subagents')).toHaveLength(3);
    expect(() => ctx.sessions.events('claude', 'nope', {})).toThrow(/not found/);
  });

  it('reports a dead registry entry as ended (adoptable)', async () => {
    await setup(false);
    expect(ctx.sessions.get('claude', 's-basic')?.live).toMatchObject({
      status: 'ended',
      ownership: 'observed',
    });
  });

  it('emits session.updated on setLive and after indexing', async () => {
    await setup();
    const seen: BusEvent[] = [];
    ctx.bus.on('session.updated', (e) => seen.push(e));
    ctx.sessions.setLive('claude:s-drift', null);
    ctx.bus.emit({ type: 'session.indexed', pk: 'claude:s-prlink' });
    expect(seen.map((e) => (e.type === 'session.updated' ? e.session.id : ''))).toEqual([
      's-drift',
      's-prlink',
    ]);
  });

  it('rejects resumes that are not allowed', async () => {
    await setup(true);
    expect(await errorOf(ctx.sessions.resume('claude', 'nope', { mode: 'embedded' }))).toMatchObject({
      status: 404,
    });
    expect(
      await errorOf(ctx.sessions.resume('claude', 's-old-prompts-only', { mode: 'embedded' })),
    ).toMatchObject({
      code: 'not_resumable',
      status: 409,
    });
    expect(await errorOf(ctx.sessions.resume('claude', 's-basic', { mode: 'embedded' }))).toMatchObject({
      code: 'session_live',
      status: 409,
      details: { pid: 41001, ownership: 'observed' },
    });
    expect(await errorOf(ctx.sessions.resume('claude', 's-drift', { mode: 'embedded' }))).toMatchObject({
      code: 'cwd_missing',
      status: 422,
    });
    expect(
      await errorOf(ctx.sessions.resume('codex', CODEX_1.slice(6), { mode: 'embedded', fork: true })),
    ).toMatchObject({
      code: 'unsupported',
    });
  });

  it('resumes into an owned PTY, guards duplicates, forks and pops out', async () => {
    await setup();
    const cwd = join(ctx.homes.root, 'work', 'live');
    const file = writeClaudeSession(ctx.homes, { sessionId: 's-live', cwd, prompt: 'resume me' });
    const indexer = await indexFixtures(ctx);
    await indexer.indexFile(file);

    const r = await ctx.sessions.resume('claude', 's-live', { mode: 'embedded', cols: 100, rows: 30 });
    if (!('ptyId' in r)) throw new Error('expected ptyId');
    let out = '';
    const a = ctx.pty.attach(r.ptyId, (d) => {
      out += d;
    });
    await vi.waitFor(() =>
      expect(out).toContain(`fake-claude --dangerously-skip-permissions --resume s-live`),
    );
    expect(out).toContain(`cwd=${realpathSync(cwd)}`);
    a.detach();
    expect(ctx.pty.get(r.ptyId)).toMatchObject({
      sessionPk: 'claude:s-live',
      cols: 100,
      rows: 30,
      command: FAKE_CLAUDE,
    });
    expect(ctx.sessions.get('claude', 's-live')?.live).toMatchObject({
      ownership: 'owned',
      ptyId: r.ptyId,
      status: 'idle',
    });
    expect(ctx.sessions.list({ q: 'resume me' }).items[0]?.live?.ptyId).toBe(r.ptyId);

    expect(await errorOf(ctx.sessions.resume('claude', 's-live', { mode: 'embedded' }))).toMatchObject({
      code: 'session_live',
      details: { ptyId: r.ptyId, ownership: 'owned' },
    });

    const fork = await ctx.sessions.resume('claude', 's-live', { mode: 'embedded', fork: true });
    if (!('ptyId' in fork)) throw new Error('expected ptyId');
    expect(ctx.pty.get(fork.ptyId)).toMatchObject({ sessionPk: null });
    expect(ctx.pty.get(fork.ptyId)?.args).toEqual([
      '--dangerously-skip-permissions',
      '--resume',
      's-live',
      '--fork-session',
    ]);
    expect(ctx.sessions.get('claude', 's-live')?.live?.ptyId).toBe(r.ptyId);

    const ext = await ctx.sessions.resume('claude', 's-live', { mode: 'external', popOut: true });
    expect(ext).toEqual({
      launched: 'external',
      command: resumeCommandLine(cwd, FAKE_CLAUDE, ['--dangerously-skip-permissions', '--resume', 's-live']),
    });
    // `cwd` sits under the OS temp dir, outside the fixtures' fake userHome (`/Users/test`), so
    // `ensureDetected()` (Task 6, not reimplemented here) auto-detects it into its own top-level
    // project (e.g. "var" or "tmp") via `projectRootFor`'s outside-home fallback, and that
    // project's `openIn` defaults to 'vscode' like any other — same as a configured project.
    expect(ctx.launches).toEqual([
      {
        cwd,
        command: FAKE_CLAUDE,
        args: ['--dangerously-skip-permissions', '--resume', 's-live'],
        openIn: 'vscode',
      },
    ]);
    expect(ctx.pty.get(r.ptyId)?.exitedAt).not.toBeNull();
    expect(ctx.sessions.get('claude', 's-live')?.live).toBeNull();
    await indexer.close();
  });

  it('builds resume commands and cursors', () => {
    ctx = createTestContext();
    const cfg = ctx.config();
    expect(buildResumeCommand({ source: 'codex', id: 'c1' }, cfg, false)).toEqual({
      command: FAKE_CLAUDE,
      args: ['resume', 'c1'],
    });
    const c = { lastActivityAt: '2026-09-01T00:00:00.000Z', pk: 'claude:x' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});
