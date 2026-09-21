import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../test/factories.ts';
import {
  createTestContext,
  FAKE_CLAUDE,
  indexFixtures,
  type TestContext,
  writeClaudeSession,
} from '../../test/helpers.ts';
import { insertHistoryPrompts } from '../db/repos/history.ts';
import { upsertSession } from '../db/repos/sessions.ts';
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

  it('preserves search-as-you-type quality after Fix round 2 (last-token-only prefixing)', async () => {
    await setup();
    // A partial final token — still being typed — must still find results via prefix match.
    const partial = ctx.sessions.list({ q: 'notif' });
    expect(partial.items.map((i) => i.pk)).toEqual(['claude:s-basic']);
    expect(partial.items[0]?.snippet?.toLowerCase()).toContain('notification');

    // A second, still-partial token narrows the match further while the first (already typed)
    // token still filters as an exact term.
    const twoToken = ctx.sessions.list({ q: 'notification serv' });
    expect(twoToken.items.map((i) => i.pk)).toEqual(['claude:s-basic']);

    // An earlier token is matched exactly, not as a prefix: 'notif' here is not the last token,
    // so it must NOT match 'notification' — proving earlier tokens genuinely filter rather than
    // silently falling back to prefix behavior everywhere.
    expect(ctx.sessions.list({ q: 'notif service' }).items).toEqual([]);
  });

  it('does not leak secrets through the history-prompt fallback (Fix round 4)', async () => {
    await setup();
    // Mirrors Fix round 3's snippet.test.ts matrix, but through the actual service-level
    // `list()` response for the history-prompt fallback (sessions.ts's `!hits.has(h.pk)` branch,
    // which previously called bare `highlight()` with no redaction at all — see the coordinator's
    // repro: `h.display` is raw, transcript-derived prompt text, exactly where a pasted
    // credential lands).
    const cases: Array<{ label: string; secret: string; leaked: (out: string) => boolean }> = [
      { label: 'keyword-anchored', secret: 'PGPASSWORD=hunter2', leaked: (out) => out.includes('hunter2') },
      {
        label: 'length-gated',
        secret: `ghp_${'a'.repeat(36)}`,
        leaked: (out) => /ghp_[A-Za-z0-9]/.test(out),
      },
    ];
    let n = 0;
    for (const { label, secret, leaked } of cases) {
      for (const dir of ['before', 'after'] as const) {
        for (const gapLen of [30, 40, 50]) {
          n += 1;
          const sessionId = `hist-fallback-${n}`;
          const gap = ' '.repeat(gapLen);
          const display =
            dir === 'before'
              ? `filler ${secret}${gap}target trailing filler text here`
              : `leading filler text here target${gap}${secret} trailing`;
          upsertSession(
            ctx.db,
            makeSession({ id: sessionId, name: `history fallback ${label} ${dir} ${gapLen}` }),
          );
          insertHistoryPrompts(ctx.db, [
            { sessionId, ts: '2026-09-01T09:00:00.000Z', display, project: '/Users/test/Wakecap' },
          ]);

          const item = ctx.sessions.list({ q: 'target' }).items.find((i) => i.pk === `claude:${sessionId}`);
          expect(item).toBeDefined();
          expect(leaked(item?.snippet ?? '')).toBe(false);
        }
      }
    }
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
