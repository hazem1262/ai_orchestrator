import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, indexFixtures, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { getArchiveEntry, upsertArchiveEntry } from '../../db/repos/archive.ts';
import { type ArchiveServiceRuntime, createArchiveService, resolveAvailability } from './archive.ts';

const homes = useTempHomes();
let ctx: TestContext;
let svc: ArchiveServiceRuntime;
const proj = () => join(homes.claudeHome, 'projects/-Users-test-Wakecap');
const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );
const syncErr = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

/** Every file under `dir` as `relative-path:size`, sorted. */
function snapshot(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      const st = statSync(p);
      return st.isDirectory() ? walk(p) : [`${relative(dir, p)}:${st.size}`];
    });
  return walk(dir).sort();
}

const evilEntry = (path: string, id: string) => ({
  path,
  sessionPk: `claude:${id}`,
  agentId: null,
  projectId: 'x',
  archivePath: join(homes.paths.archiveDir, 'x', `${id}.jsonl.gz`),
  codec: 'gzip' as const,
  sourceSize: 1,
  sourceMtimeMs: 1,
  bytes: 1,
  archivedAt: '2026-09-01T00:00:00.000Z',
  headFingerprint: null,
});

beforeEach(async () => {
  ctx = createTestContext({ homes });
  await indexFixtures(ctx);
  svc = createArchiveService(ctx, { codec: 'gzip' });
  expect(await svc.syncAll()).toEqual({ copied: 9 });
});

afterEach(() => {
  svc.stop();
  ctx.dispose();
  vi.restoreAllMocks();
});

describe('resolveAvailability', () => {
  it('orders remote > resumable > archived > prompts-only', () => {
    expect(
      resolveAvailability({ transcriptExists: true, archived: true, hasPrompts: true, remote: true }),
    ).toBe('remote');
    expect(resolveAvailability({ transcriptExists: true, archived: true, hasPrompts: true })).toBe(
      'resumable',
    );
    expect(resolveAvailability({ transcriptExists: false, archived: true, hasPrompts: true })).toBe(
      'archived',
    );
    expect(resolveAvailability({ transcriptExists: false, archived: false, hasPrompts: true })).toBe(
      'prompts-only',
    );
  });
});

describe('session availability', () => {
  it('reports archived for a session whose transcript is gone but whose archive entry exists', () => {
    rmSync(join(proj(), 's-basic.jsonl'));
    expect(ctx.sessions.get('claude', 's-basic')?.availability).toBe('archived');
    const archived = ctx.sessions.list({ availability: 'archived' }).items.map((i) => i.pk);
    expect(archived).toEqual(['claude:s-basic']);
    const row = ctx.sessions.list({}).items.find((i) => i.pk === 'claude:s-basic');
    expect(row?.availability).toBe('archived');
    expect(ctx.sessions.list({ availability: 'resumable' }).items.map((i) => i.pk)).not.toContain(
      'claude:s-basic',
    );
  });

  it('reports prompts-only when the transcript is gone and nothing was archived', () => {
    rmSync(join(proj(), 's-drift.jsonl'));
    ctx.raw.prepare("DELETE FROM archive_entries WHERE session_pk = 'claude:s-drift'").run();
    expect(ctx.sessions.get('claude', 's-drift')?.availability).toBe('prompts-only');
    expect(ctx.sessions.list({}).items.find((i) => i.pk === 'claude:s-drift')?.availability).toBe(
      'prompts-only',
    );
  });
});

describe('restorePlan', () => {
  it('refuses non-claude sources and sessions with no archive entries', () => {
    expect(syncErr(() => svc.restorePlan('codex', 'x'))).toMatchObject({
      status: 400,
      code: 'unsupported_source',
    });
    expect(syncErr(() => svc.restorePlan('claude', 'nope'))).toMatchObject({
      status: 404,
      code: 'not_archived',
    });
  });

  it('lists every original transcript path for the session, sorted', () => {
    expect(svc.restorePlan('claude', 's-subagents').targets).toEqual([
      join(proj(), 's-subagents.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag1.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag2.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag3.jsonl'),
    ]);
    expect(svc.restorePlan('claude', 's-basic').targets).toEqual([join(proj(), 's-basic.jsonl')]);
  });
});

describe('restore', () => {
  it('restores a deleted transcript byte-for-byte with mode 0600 and flips availability', async () => {
    const original = readFileSync(join(proj(), 's-basic.jsonl'));
    rmSync(join(proj(), 's-basic.jsonl'));
    expect(ctx.sessions.get('claude', 's-basic')?.availability).toBe('archived');
    await svc.restore('claude', 's-basic');
    expect(readFileSync(join(proj(), 's-basic.jsonl')).equals(original)).toBe(true);
    expect(statSync(join(proj(), 's-basic.jsonl')).mode & 0o777).toBe(0o600);
    expect(ctx.sessions.get('claude', 's-basic')?.availability).toBe('resumable');
    expect(await svc.syncAll()).toEqual({ copied: 0 });
  });

  it('writes only the planned targets under claudeHome', async () => {
    // The subagent `.meta.json` sidecars are not transcripts and are never archived, so removing
    // the directory loses them for good; everything else must come back exactly.
    const before = snapshot(homes.claudeHome).filter(
      (f) => !/^projects\/[^/]+\/s-subagents\/.*\.meta\.json:/.test(f),
    );
    rmSync(join(proj(), 's-subagents.jsonl'));
    rmSync(join(proj(), 's-subagents'), { recursive: true });
    await svc.restore('claude', 's-subagents');
    expect(snapshot(homes.claudeHome)).toEqual(before);
  });

  it('refuses to overwrite and writes nothing when any target exists', async () => {
    rmSync(join(proj(), 's-subagents.jsonl'));
    const err = await errOf(svc.restore('claude', 's-subagents'));
    expect(err).toMatchObject({ status: 409, code: 'restore_target_exists' });
    expect((err as { details: { paths: string[] } }).details.paths.sort()).toEqual([
      join(proj(), 's-subagents/subagents/agent-ag1.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag2.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag3.jsonl'),
    ]);
    expect(existsSync(join(proj(), 's-subagents.jsonl'))).toBe(false);
  });

  it('refuses when the live transcript exists, leaving it untouched', async () => {
    writeFileSync(join(proj(), 's-basic.jsonl'), 'live and newer\n');
    expect(await errOf(svc.restore('claude', 's-basic'))).toMatchObject({
      status: 409,
      code: 'restore_target_exists',
    });
    expect(readFileSync(join(proj(), 's-basic.jsonl'), 'utf8')).toBe('live and newer\n');
  });

  it('refuses unknown ids and non-claude sources', async () => {
    expect(await errOf(svc.restore('claude', 'nope'))).toMatchObject({ status: 404, code: 'not_archived' });
    expect(await errOf(svc.restore('codex', 's-basic'))).toMatchObject({
      status: 400,
      code: 'unsupported_source',
    });
  });

  it('writes nothing when one archive of the session is corrupt', async () => {
    rmSync(join(proj(), 's-subagents.jsonl'));
    rmSync(join(proj(), 's-subagents'), { recursive: true });
    const ag2 = getArchiveEntry(ctx.db, join(proj(), 's-subagents/subagents/agent-ag2.jsonl'));
    if (!ag2) throw new Error('fixture: ag2 was not archived');
    writeFileSync(ag2.archivePath, 'not a gzip stream');
    expect(await errOf(svc.restore('claude', 's-subagents'))).not.toBeNull();
    expect(existsSync(join(proj(), 's-subagents.jsonl'))).toBe(false);
    expect(existsSync(join(proj(), 's-subagents'))).toBe(false);
  });

  it('rejects targets outside <claudeHome>/projects', async () => {
    upsertArchiveEntry(ctx.db, evilEntry('/tmp/evil.jsonl', 'evil'));
    expect(await errOf(svc.restore('claude', 'evil'))).toMatchObject({ status: 400, code: 'invalid_target' });

    upsertArchiveEntry(ctx.db, evilEntry(join(homes.claudeHome, 'projects/../settings.json'), 'dotdot'));
    expect(await errOf(svc.restore('claude', 'dotdot'))).toMatchObject({
      status: 400,
      code: 'invalid_target',
    });

    upsertArchiveEntry(ctx.db, evilEntry(join(homes.claudeHome, 'projects-evil/x.jsonl'), 'sibling'));
    expect(await errOf(svc.restore('claude', 'sibling'))).toMatchObject({
      status: 400,
      code: 'invalid_target',
    });
    expect(existsSync(join(homes.claudeHome, 'projects-evil'))).toBe(false);
  });

  it('logs the restore with the session key', async () => {
    const info = vi.spyOn(ctx.log, 'info');
    rmSync(join(proj(), 's-basic.jsonl'));
    await svc.restore('claude', 's-basic');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPk: 'claude:s-basic' }),
      expect.any(String),
    );
  });
});
