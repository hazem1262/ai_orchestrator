import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTempHomes, writeClaudeSession } from '../../test/helpers.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { type OrcDb, openDb } from '../db/client.ts';
import { listAgents } from '../db/repos/agents.ts';
import { countEvents, listEvents } from '../db/repos/events.ts';
import { getFileOffset } from '../db/repos/file-offsets.ts';
import { getSessionByPk, getSessionOrigin } from '../db/repos/sessions.ts';
import { type BusEvent, createEventBus, type EventBus } from '../live/event-bus.ts';
import { createProjectService } from '../services/projects.ts';
import { listIndexableFiles } from './file-kinds.ts';
import { createIndexer, type Indexer } from './indexer.ts';

/**
 * Waits for the actual `session.indexed` signal for `pk` rather than polling the database or
 * sleeping a fixed duration — a real miss (event never fires) surfaces as a clear timeout error
 * instead of silently passing or masking a hang.
 */
function waitForIndexed(bus: EventBus, pk: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for session.indexed pk=${pk}`));
    }, timeoutMs);
    const off = bus.on('session.indexed', (e) => {
      if (e.pk !== pk) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

const WAKE = 'projects/-Users-test-Wakecap';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${createHash('sha1').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

describe('indexer', () => {
  const homes = useTempHomes();
  let db: OrcDb;
  let close: () => void;
  let indexer: Indexer;
  let events: BusEvent[];
  let bus: EventBus;

  beforeEach(() => {
    const opened = openDb(homes.paths.dbFile);
    db = opened.db;
    close = opened.close;
    let cfg: OrcConfig = loadConfig(homes.paths);
    const projects = createProjectService({
      db,
      paths: homes.paths,
      config: () => cfg,
      saveConfig: (next) => {
        saveConfig(homes.paths, next);
        cfg = next;
      },
    });
    bus = createEventBus();
    events = [];
    bus.on('index.progress', (e) => events.push(e));
    bus.on('session.indexed', (e) => events.push(e));
    indexer = createIndexer({
      db,
      raw: opened.raw,
      paths: homes.paths,
      projects,
      bus,
      log: pino({ level: 'silent' }),
      debounceMs: 20,
      // Short reconcile interval so watch()'s periodic backstop (see indexer.ts) can be exercised
      // and asserted on without the test needing to wait anywhere near production's default.
      reconcileMs: 150,
    });
  });

  afterEach(async () => {
    await indexer.close();
    close();
  });

  it('indexes the fixture homes', async () => {
    const stats = await indexer.scanAll();
    // 6 main + 3 subagent + 3 codex rollouts + 1 history.jsonl (fixtures/codex-home carries a
    // third rollout, added after this brief's numbers were written, that exercises tool_search /
    // web_search parsing — see packages/core/src/codex/codex-aggregate.test.ts).
    expect(stats).toMatchObject({ files: 13, sessions: 11 });
    expect(events.filter((e) => e.type === 'index.progress').at(-1)).toEqual({
      type: 'index.progress',
      done: 13,
      total: 13,
    });
    expect(events.some((e) => e.type === 'session.indexed' && e.pk === 'claude:s-basic')).toBe(true);

    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({
      availability: 'resumable',
      projectId: 'wakecap',
      promptCount: 3,
      name: 'Notification service test check',
    });
    expect(getSessionOrigin(db, 'claude:s-basic')).toBe('transcript');
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    expect(getSessionByPk(db, 'claude:s-old-prompts-only')).toMatchObject({
      availability: 'prompts-only',
      projectId: 'wakecap',
      name: 'old session from december',
    });
    expect(getSessionByPk(db, 'claude:s-errors')?.projectId).toBe('forza');
    expect(getSessionByPk(db, 'claude:s-stocks')?.projectId).toBe('stocks');
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000002')?.flags.automated).toBe(true);
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000001')?.projectId).toBe('wakecap');
    // Third codex fixture (tool_search / web_search) is also indexed, and not marked automated.
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000003')).toMatchObject({
      projectId: 'wakecap',
      flags: expect.objectContaining({ automated: false }),
    });
    expect(getSessionByPk(db, 'claude:s-subagents')?.flags.hasSubagents).toBe(true);
    const agents = listAgents(db, 'claude:s-subagents');
    expect(agents.map((a) => [a.id, a.parentId, a.background])).toEqual([
      ['ag1', null, true],
      ['ag2', 'ag1', false],
      ['ag3', 'ag2', false],
    ]);
    expect(listEvents(db, 'claude:s-subagents', { agentId: 'ag1' }).items).toHaveLength(2);
    expect(indexer.unknownTypes()).toMatchObject({ 'future-record-kind': 1 });
  });

  it('is idempotent and never writes to the tool homes', async () => {
    const before = { ...snapshot(homes.claudeHome), ...snapshot(homes.codexHome) };
    await indexer.scanAll();
    await indexer.scanAll();
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    expect({ ...snapshot(homes.claudeHome), ...snapshot(homes.codexHome) }).toEqual(before);
  });

  it('continues from the stored offset on append', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-basic.jsonl');
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'user', uuid: 'u5', parentUuid: 'u4', isSidechain: false, sessionId: 's-basic', timestamp: '2026-09-01T09:10:00.000Z', cwd: '/Users/test/Wakecap', message: { role: 'user', content: 'one more thing' } })}\n`,
    );
    await indexer.indexFile(file);
    const page = listEvents(db, 'claude:s-basic', { afterSeq: 10 });
    expect(page.items.map((e) => [e.seq, e.turn, e.text])).toEqual([[11, 4, 'one more thing']]);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({
      promptCount: 4,
      lastActivityAt: '2026-09-01T09:10:00.000Z',
    });
  });

  it('picks up a truncated line once it is completed', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-errors.jsonl');
    expect(countEvents(db, 'claude:s-errors')).toBe(2);
    appendFileSync(
      file,
      '5.000Z","cwd":"/Users/test/Forza","message":{"id":"em2","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"recovered"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n',
    );
    await indexer.indexFile(file);
    expect(listEvents(db, 'claude:s-errors', {}).items.at(-1)?.text).toBe('recovered');
    expect(getSessionByPk(db, 'claude:s-errors')?.models).toEqual(['claude-opus-5']);
  });

  it('keeps events when a transcript disappears and history does not clobber it', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-basic.jsonl');
    rmSync(file);
    await indexer.indexFile(file);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({
      availability: 'prompts-only',
      transcriptPath: null,
    });
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    const history = join(homes.claudeHome, 'history.jsonl');
    appendFileSync(
      history,
      `${JSON.stringify({ display: 'later', pastedContents: {}, timestamp: 1788260000000, project: '/Users/test/Wakecap', sessionId: 's-basic' })}\n`,
    );
    await indexer.indexFile(history);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({
      promptCount: 3,
      name: 'Notification service test check',
    });
  });

  // CONTROLLER RULING: truncation recovery is mandatory. Claude Code rewrites a transcript on
  // compaction and replaces it on /clear, which shows up here as `readJsonlFrom` reporting
  // `truncated: true` because the stored offset is now past the (shorter) file's end. The
  // indexer must reset that path's stored offset to 0 and re-index from the start rather than
  // silently treating the shrink as "no new data forever".
  it('re-reads a file that shrank (truncation recovery)', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-drift.jsonl');
    const before = getFileOffset(db, file);
    expect(before?.offset).toBeGreaterThan(0);
    expect(countEvents(db, 'claude:s-drift')).toBe(3);

    const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
    rmSync(file);
    appendFileSync(file, `${first}\n`);
    const shrunkSize = statSync(file).size;
    expect(shrunkSize).toBeLessThan(before?.size ?? 0);

    await indexer.indexFile(file);

    // The session now reflects only the new, shorter content: one prompt, not three events.
    expect(countEvents(db, 'claude:s-drift')).toBe(1);
    expect(listEvents(db, 'claude:s-drift', {}).items).toEqual([
      expect.objectContaining({ seq: 1, kind: 'prompt', text: 'look at the svc repo' }),
    ]);
    expect(getSessionByPk(db, 'claude:s-drift')).toMatchObject({
      promptCount: 1,
      lastActivityAt: '2026-09-03T08:00:00.000Z',
    });

    // The stored offset is sane: it matches the shrunk file's size, not a stale, now-out-of-range
    // value carried over from before the truncation.
    const after = getFileOffset(db, file);
    expect(after?.offset).toBe(shrunkSize);
    expect(after?.size).toBe(shrunkSize);
    expect(after?.offset).toBeLessThanOrEqual(shrunkSize);
  });

  // FIX ROUND 1 finding: a transcript replaced with DIFFERENT content of the EXACT same byte
  // length moves mtime but not size. `readJsonlFrom`'s `truncated` flag never fires (the stored
  // offset never exceeds the new size), and the plain (size, mtime) skip only fires when BOTH
  // are unchanged — so the old (size-only) fast path missed this case entirely and the session
  // stayed silently stale forever. The head-fingerprint guard must catch it.
  it('re-reads a file replaced with different content of the same byte length', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-drift.jsonl');
    expect(countEvents(db, 'claude:s-drift')).toBe(3);
    const originalSize = statSync(file).size;

    const rec = {
      type: 'user',
      uuid: 'z-u1',
      parentUuid: null,
      isSidechain: false,
      sessionId: 's-drift',
      timestamp: '2026-09-03T09:30:00.000Z',
      cwd: '/Users/test/Wakecap',
      message: { role: 'user', content: '' },
    };
    const pad = originalSize - Buffer.byteLength(`${JSON.stringify(rec)}\n`, 'utf8');
    expect(pad).toBeGreaterThan(0); // sanity: the fixture has room to pad to the same size
    rec.message.content = `REPLACED-${'x'.repeat(Math.max(pad - 'REPLACED-'.length, 0))}`;
    const newLine = `${JSON.stringify(rec)}\n`;
    expect(Buffer.byteLength(newLine, 'utf8')).toBe(originalSize);

    writeFileSync(file, newLine);
    expect(statSync(file).size).toBe(originalSize); // same size as before...
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000)); // ...but a newer mtime

    await indexer.indexFile(file);

    // Session and events reflect the NEW content only — no duplicates from the old 3 events.
    expect(countEvents(db, 'claude:s-drift')).toBe(1);
    expect(listEvents(db, 'claude:s-drift', {}).items).toEqual([
      expect.objectContaining({ seq: 1, kind: 'prompt', text: rec.message.content }),
    ]);
    expect(getSessionByPk(db, 'claude:s-drift')).toMatchObject({
      promptCount: 1,
      firstPrompt: rec.message.content,
      lastActivityAt: '2026-09-03T09:30:00.000Z',
    });

    const after = getFileOffset(db, file);
    expect(after?.offset).toBe(originalSize);
    expect(after?.size).toBe(originalSize);
  });

  // FLAKE FIX: chokidar's `ready` event is already awaited inside `watch()` before it resolves
  // (confirmed — see task-10-report.md "Flake fix"), so a write placed immediately after `await
  // watch()` here is not racing watch()'s own startup. The flake was that the underlying native
  // fs-watch backend can itself drop or indefinitely delay an event under system load, for a
  // file in a brand-new subdirectory *or* an already-watched one — verified empirically by
  // instrumenting chokidar's `add`/`addDir`/`change` events and observing zero of them fire
  // within 8s on a failing run. `watch()` now runs a periodic reconciliation sweep
  // (`reconcileMs`, overridden to 150ms above) as a backstop, so this no longer depends on that
  // native event ever arriving. The assertion below waits on the real `session.indexed` bus
  // signal (not a fixed sleep, not a raw DB poll) with a generous timeout, so a genuine
  // regression still fails loudly instead of being masked.
  it('indexes a transcript written immediately after watch() resolves', async () => {
    await indexer.scanAll();
    await indexer.watch();
    writeClaudeSession(homes, {
      sessionId: 's-new',
      cwd: join(homes.root, 'work', 'Wakecap'),
      prompt: 'watched prompt',
    });
    await waitForIndexed(bus, 'claude:s-new', 8000);
    expect(getSessionByPk(db, 'claude:s-new')?.firstPrompt).toBe('watched prompt');
  });

  // RECONCILE NARROWING: the periodic sweep may skip a Codex rollout the index already knows is
  // `automated` (`codex_sdk_ts`, hidden in the UI by default), but only for the sweep itself
  // (never scanAll(), never the watcher's own indexFile call when an OS event does arrive), and
  // never for a path file_offsets has not seen yet.
  it('reconcile sweep skips a known-automated codex rollout, but still sweeps an unknown or non-automated one', async () => {
    await indexer.scanAll();

    const knownAutomatedFile = join(
      homes.codexHome,
      'sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl',
    );
    const nonAutomatedFile = join(
      homes.codexHome,
      'sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl',
    );
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000002')).toMatchObject({
      promptCount: 1,
      flags: expect.objectContaining({ automated: true }),
    });
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000001')).toMatchObject({
      promptCount: 1,
      flags: expect.objectContaining({ automated: false }),
    });

    // Real changes to BOTH: if the known-automated one is genuinely skipped by the sweep, its
    // promptCount must stay at 1; the non-automated one is a control that must still update.
    appendFileSync(
      knownAutomatedFile,
      `${JSON.stringify({
        timestamp: '2026-03-10T09:05:00.000Z',
        ordinal: 2,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'must be skipped' }],
        },
      })}\n`,
    );
    appendFileSync(
      nonAutomatedFile,
      `${JSON.stringify({
        timestamp: '2026-09-01T09:05:00.000Z',
        ordinal: 8,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'must be swept' }] },
      })}\n`,
    );

    // A brand-new, NEVER-indexed rollout that is also automated — "known automated" requires it
    // to already be in the index, so this one must be swept despite its originator.
    const newDir = join(homes.codexHome, 'sessions/2026/09/05');
    mkdirSync(newDir, { recursive: true });
    const unseenFile = join(newDir, 'rollout-2026-09-05T09-00-00-c0dex000-0000-0000-0000-000000000099.jsonl');
    writeFileSync(
      unseenFile,
      `${[
        JSON.stringify({
          timestamp: '2026-09-05T09:00:00.000Z',
          ordinal: 0,
          type: 'session_meta',
          payload: {
            id: 'c0dex000-0000-0000-0000-000000000099',
            session_id: 'c0dex000-0000-0000-0000-000000000099',
            cwd: '/Users/test/Wakecap',
            originator: 'codex_sdk_ts',
          },
        }),
        JSON.stringify({
          timestamp: '2026-09-05T09:00:02.000Z',
          ordinal: 1,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'brand new automated session must still be swept' }],
          },
        }),
      ].join('\n')}\n`,
    );

    const totalFiles = listIndexableFiles(homes.paths).length;
    const result = await indexer.reconcile();

    expect(result).toEqual({ skipped: 1, swept: totalFiles - 1 });
    // The known-automated file's session is untouched: the sweep really did skip it, not just
    // happen to leave it unchanged.
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000002')?.promptCount).toBe(1);
    // The control (non-automated) and the never-before-seen automated rollout were both swept.
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000001')?.promptCount).toBe(2);
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000099')).toMatchObject({
      firstPrompt: 'brand new automated session must still be swept',
      flags: expect.objectContaining({ automated: true }),
    });

    // The watcher still reacts normally to the known-automated file once an event does arrive —
    // the narrowing applies only to the periodic sweep, never to a direct/watched index.
    await indexer.indexFile(knownAutomatedFile);
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000002')?.promptCount).toBe(2);
  });
});
