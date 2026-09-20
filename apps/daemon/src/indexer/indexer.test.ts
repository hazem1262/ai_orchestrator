import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes, writeClaudeSession } from '../../test/helpers.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { type OrcDb, openDb } from '../db/client.ts';
import { listAgents } from '../db/repos/agents.ts';
import { countEvents, listEvents } from '../db/repos/events.ts';
import { getFileOffset } from '../db/repos/file-offsets.ts';
import { getSessionByPk, getSessionOrigin } from '../db/repos/sessions.ts';
import { type BusEvent, createEventBus } from '../live/event-bus.ts';
import { createProjectService } from '../services/projects.ts';
import { createIndexer, type Indexer } from './indexer.ts';

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
    const bus = createEventBus();
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

  it('watches for new transcripts', async () => {
    await indexer.scanAll();
    await indexer.watch();
    writeClaudeSession(homes, {
      sessionId: 's-new',
      cwd: join(homes.root, 'work', 'Wakecap'),
      prompt: 'watched prompt',
    });
    await vi.waitFor(() => expect(getSessionByPk(db, 'claude:s-new')?.firstPrompt).toBe('watched prompt'), {
      timeout: 8000,
      interval: 100,
    });
  });
});
