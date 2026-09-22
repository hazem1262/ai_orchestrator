import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, indexFixtures, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { getArchiveEntry } from '../../db/repos/archive.ts';
import {
  type ArchiveServiceRuntime,
  createArchiveService,
  listClaudeTranscripts,
  readCleanupPeriodDays,
} from './archive.ts';
import { availableCodec, codecExtension, decompressBuffer } from './compress.ts';

/**
 * Every file write and rename made through `node:fs` or `node:fs/promises` is recorded (and still
 * performed), so the tests can check the `<path>.tmp` then rename protocol and that nothing is
 * ever written under `claudeHome`.
 */
const fsCalls = vi.hoisted(() => [] as Array<{ op: 'write' | 'rename'; from: string; to?: string }>);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof real.writeFile = (file, ...rest) => {
    fsCalls.push({ op: 'write', from: String(file) });
    return real.writeFile(file, ...rest);
  };
  const rename: typeof real.rename = (from, to) => {
    fsCalls.push({ op: 'rename', from: String(from), to: String(to) });
    return real.rename(from, to);
  };
  return { ...real, writeFile, rename, default: { ...real, writeFile, rename } };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const writeFileSync: typeof real.writeFileSync = (file, ...rest) => {
    fsCalls.push({ op: 'write', from: String(file) });
    return real.writeFileSync(file, ...rest);
  };
  const renameSync: typeof real.renameSync = (from, to) => {
    fsCalls.push({ op: 'rename', from: String(from), to: String(to) });
    return real.renameSync(from, to);
  };
  return { ...real, writeFileSync, renameSync, default: { ...real, writeFileSync, renameSync } };
});

const homes = useTempHomes();
let ctx: TestContext;
let svc: ArchiveServiceRuntime;
let cfg: OrcConfig;
const codec = availableCodec();
const proj = () => join(homes.claudeHome, 'projects/-Users-test-Wakecap');
const projectOf = (sessionId: string) =>
  ctx.sessions.getByPk(`claude:${sessionId}`)?.projectId ?? '_unassigned';
const archived = (sessionId: string) =>
  join(homes.paths.archiveDir, projectOf(sessionId), `${sessionId}.jsonl${codecExtension(codec)}`);

/** Same format as the indexer's `file_offsets.head_fingerprint`: total size + sha1 of the first 4 KiB. */
const headFingerprint = (buf: Buffer) =>
  `${buf.length}:${createHash('sha1').update(buf.subarray(0, 4096)).digest('hex')}`;

function snapshot(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      const st = statSync(p);
      return st.isDirectory() ? walk(p) : [`${relative(dir, p)}:${st.size}:${st.mtimeMs}`];
    });
  return walk(dir).sort();
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

beforeEach(() => {
  ctx = createTestContext({ homes });
  cfg = ctx.config();
  ctx.config = () => cfg;
  svc = createArchiveService(ctx, { codec });
  fsCalls.length = 0;
});

afterEach(() => {
  svc.stop();
  ctx.dispose();
  vi.restoreAllMocks();
});

describe('listClaudeTranscripts', () => {
  it('finds main and subagent transcripts only', () => {
    const files = listClaudeTranscripts(homes.claudeHome);
    const names = files.map((f) => `${f.sessionId}/${f.agentId ?? '-'}`).sort();
    expect(names).toEqual([
      's-basic/-',
      's-drift/-',
      's-errors/-',
      's-prlink/-',
      's-subagents/-',
      's-subagents/ag1',
      's-subagents/ag2',
      's-subagents/ag3',
      's-unknown/-',
    ]);
    const basic = files.find((f) => f.sessionId === 's-basic' && f.agentId === null);
    expect(basic?.path).toBe(join(proj(), 's-basic.jsonl'));
    expect(basic?.size).toBe(statSync(join(proj(), 's-basic.jsonl')).size);
  });

  it('excludes tool-results and file-history', () => {
    mkdirSync(join(proj(), 's-basic/tool-results'), { recursive: true });
    writeFileSync(join(proj(), 's-basic/tool-results/toolu_1.jsonl'), '{}\n');
    writeFileSync(join(proj(), 's-basic/tool-results/toolu_2.txt'), 'x');
    mkdirSync(join(proj(), 's-basic/file-history'), { recursive: true });
    writeFileSync(join(proj(), 's-basic/file-history/f.jsonl'), '{}\n');
    mkdirSync(join(homes.claudeHome, 'file-history/s-basic'), { recursive: true });
    writeFileSync(join(homes.claudeHome, 'file-history/s-basic/abc@v1.jsonl'), '{}\n');

    const paths = listClaudeTranscripts(homes.claudeHome).map((f) => f.path);
    expect(paths).toHaveLength(9);
    expect(paths.some((p) => p.includes('tool-results') || p.includes('file-history'))).toBe(false);
  });

  it('returns nothing when ~/.claude/projects is missing', () => {
    expect(listClaudeTranscripts(join(homes.root, 'no-such-claude-home'))).toEqual([]);
  });
});

describe('ArchiveService.syncAll', () => {
  it('copies every transcript once, compressed, without touching ~/.claude', async () => {
    const before = snapshot(homes.claudeHome);
    expect(await svc.syncAll()).toEqual({ copied: 9 });
    expect(snapshot(homes.claudeHome)).toEqual(before);
    const src = readFileSync(join(proj(), 's-basic.jsonl'));
    const out = await decompressBuffer(readFileSync(archived('s-basic')), codec);
    expect(out.equals(src)).toBe(true);
    expect(getArchiveEntry(ctx.db, join(proj(), 's-subagents/subagents/agent-ag2.jsonl'))).toMatchObject({
      sessionPk: 'claude:s-subagents',
      agentId: 'ag2',
      codec,
    });
    expect(
      existsSync(
        join(
          homes.paths.archiveDir,
          projectOf('s-subagents'),
          's-subagents/subagents',
          `agent-ag2.jsonl${codecExtension(codec)}`,
        ),
      ),
    ).toBe(true);
    expect(await svc.syncAll()).toEqual({ copied: 0 });
  });

  it('archives subagent transcripts and nothing from tool-results or file-history', async () => {
    mkdirSync(join(proj(), 's-basic/tool-results'), { recursive: true });
    writeFileSync(join(proj(), 's-basic/tool-results/toolu_1.jsonl'), '{}\n');
    mkdirSync(join(homes.claudeHome, 'file-history/s-basic'), { recursive: true });
    writeFileSync(join(homes.claudeHome, 'file-history/s-basic/abc@v1.jsonl'), '{}\n');

    expect(await svc.syncAll()).toEqual({ copied: 9 });
    const files = walkFiles(homes.paths.archiveDir).map((p) => relative(homes.paths.archiveDir, p));
    expect(files).toHaveLength(9);
    expect(files.filter((p) => p.includes('/subagents/agent-'))).toHaveLength(3);
    expect(files.some((p) => p.includes('tool-results') || p.includes('file-history'))).toBe(false);
    expect(files.every((p) => p.endsWith(`.jsonl${codecExtension(codec)}`))).toBe(true);
  });

  it('files an indexed session under its projectId', async () => {
    await indexFixtures(ctx);
    await svc.syncAll();
    const entry = getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'));
    expect(entry?.projectId).toBe(projectOf('s-basic'));
    expect(entry?.archivePath).toBe(archived('s-basic'));
    expect(existsSync(archived('s-basic'))).toBe(true);
  });

  it('files an unindexed session under _unassigned', async () => {
    await svc.syncAll();
    expect(getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'))?.archivePath).toBe(
      join(homes.paths.archiveDir, '_unassigned', `s-basic.jsonl${codecExtension(codec)}`),
    );
  });

  it('writes each archive file as <path>.tmp, then renames it, and never writes under claudeHome', async () => {
    await svc.syncAll();
    const target = archived('s-basic');
    const writes = fsCalls.filter((c) => c.op === 'write').map((c) => c.from);
    expect(writes).toContain(`${target}.tmp`);
    expect(writes).not.toContain(target);
    const tmpIdx = fsCalls.findIndex((c) => c.op === 'write' && c.from === `${target}.tmp`);
    const renameIdx = fsCalls.findIndex(
      (c) => c.op === 'rename' && c.from === `${target}.tmp` && c.to === target,
    );
    expect(renameIdx).toBeGreaterThan(tmpIdx);
    expect(
      fsCalls.some((c) => c.from.startsWith(homes.claudeHome) || c.to?.startsWith(homes.claudeHome)),
    ).toBe(false);
    expect(walkFiles(homes.paths.archiveDir).some((p) => p.endsWith('.tmp'))).toBe(false);
  });

  it('re-copies a transcript that grew and ignores one that shrank', async () => {
    await svc.syncAll();
    appendFileSync(
      join(proj(), 's-basic.jsonl'),
      '{"type":"user","uuid":"z","sessionId":"s-basic","timestamp":"2026-09-02T00:00:00.000Z","message":{"role":"user","content":"more"}}\n',
    );
    expect(await svc.syncAll()).toEqual({ copied: 1 });
    const grown = readFileSync(join(proj(), 's-basic.jsonl'));
    expect((await decompressBuffer(readFileSync(archived('s-basic')), codec)).equals(grown)).toBe(true);
    expect(getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'))?.sourceSize).toBe(grown.length);

    writeFileSync(join(proj(), 's-basic.jsonl'), '{}\n');
    expect(await svc.syncAll()).toEqual({ copied: 0 });
    expect((await decompressBuffer(readFileSync(archived('s-basic')), codec)).equals(grown)).toBe(true);
    expect(getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'))?.sourceSize).toBe(grown.length);
  });

  it('logs a warning when a transcript shrank', async () => {
    await svc.syncAll();
    const warn = vi.spyOn(ctx.log, 'warn');
    writeFileSync(join(proj(), 's-basic.jsonl'), '{}\n');
    await svc.syncAll();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: join(proj(), 's-basic.jsonl') }),
      expect.any(String),
    );
  });

  it('ignores a same-size mtime change when the content is unchanged', async () => {
    await svc.syncAll();
    const file = join(proj(), 's-basic.jsonl');
    const entry = getArchiveEntry(ctx.db, file);
    utimesSync(file, new Date('2026-09-10T00:00:00.000Z'), new Date('2026-09-10T00:00:00.000Z'));
    expect(await svc.syncAll()).toEqual({ copied: 0 });
    expect(getArchiveEntry(ctx.db, file)?.archivedAt).toBe(entry?.archivedAt);
  });

  it('does nothing when disabled', async () => {
    cfg = { ...cfg, archive: { ...cfg.archive, enabled: false } };
    expect(await svc.syncAll()).toEqual({ copied: 0 });
    expect(existsSync(homes.paths.archiveDir) ? walkFiles(homes.paths.archiveDir) : []).toEqual([]);
    expect(svc.status().enabled).toBe(false);
  });

  it('shares a sync that is already running', async () => {
    const [a, b] = await Promise.all([svc.syncAll(), svc.syncAll()]);
    expect(a).toEqual({ copied: 9 });
    expect(b).toBe(a);
  });

  it('can be forced to gzip', async () => {
    const gz = createArchiveService(ctx, { codec: 'gzip' });
    await gz.syncAll();
    expect(gz.codec()).toBe('gzip');
    const entry = getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'));
    expect(entry?.codec).toBe('gzip');
    expect(entry?.archivePath.endsWith('.jsonl.gz')).toBe(true);
  });
});

describe('ArchiveService head fingerprint', () => {
  const headOf = (path: string): string | null => {
    const row = ctx.raw
      .prepare('select head_fingerprint as h from archive_entries where path = ?')
      .get(path) as { h: string | null } | undefined;
    return row?.h ?? null;
  };

  it('adds a head_fingerprint column to archive_entries', () => {
    const cols = (ctx.raw.prepare('pragma table_info(archive_entries)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('head_fingerprint');
  });

  it('records the 4 KiB head fingerprint of the copied source', async () => {
    await svc.syncAll();
    const file = join(proj(), 's-basic.jsonl');
    expect(headOf(file)).toBe(headFingerprint(readFileSync(file)));
    expect(getArchiveEntry(ctx.db, file)).toMatchObject({
      headFingerprint: headFingerprint(readFileSync(file)),
    });
  });

  it('re-copies a transcript rewritten with the same size and the same mtime but a different head', async () => {
    const file = join(proj(), 's-basic.jsonl');
    // A whole-second mtime round-trips through utimesSync exactly; a sub-millisecond one does not.
    const pinned = new Date('2026-09-01T00:00:00.000Z');
    utimesSync(file, pinned, pinned);
    await svc.syncAll();
    const original = readFileSync(file);
    const { atime, mtime } = statSync(file);

    // Same byte length, different first bytes, then the original mtime put back.
    const rewritten = Buffer.from(original);
    rewritten.write('{"type":"xxxx"', 0, 'utf8');
    expect(rewritten.equals(original)).toBe(false);
    expect(rewritten.length).toBe(original.length);
    writeFileSync(file, rewritten);
    utimesSync(file, atime, mtime);
    expect(statSync(file).size).toBe(original.length);
    expect(statSync(file).mtimeMs).toBe(mtime.getTime());

    expect(await svc.syncAll()).toEqual({ copied: 1 });
    expect((await decompressBuffer(readFileSync(archived('s-basic')), codec)).equals(rewritten)).toBe(true);
    expect(headOf(file)).toBe(headFingerprint(rewritten));
    expect(await svc.syncAll()).toEqual({ copied: 0 });
  });
});

describe('ArchiveService.status', () => {
  it('reports totals, oldest transcript and cleanupPeriodDays', async () => {
    expect(svc.status()).toMatchObject({ enabled: true, files: 0, bytes: 0, cleanupPeriodDays: null });
    utimesSync(
      join(proj(), 's-drift.jsonl'),
      new Date('2026-08-16T00:00:00.000Z'),
      new Date('2026-08-16T00:00:00.000Z'),
    );
    writeFileSync(
      join(homes.claudeHome, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 45, hooks: {} }),
    );
    await svc.syncAll();
    const s = svc.status();
    expect(s.files).toBe(9);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.oldestTranscript).toBe('2026-08-16T00:00:00.000Z');
    expect(s.cleanupPeriodDays).toBe(45);
  });

  it('ignores subagent transcripts when finding the oldest transcript', () => {
    utimesSync(
      join(proj(), 's-subagents/subagents/agent-ag1.jsonl'),
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-01-01T00:00:00.000Z'),
    );
    expect(svc.status().oldestTranscript).not.toBe('2025-01-01T00:00:00.000Z');
  });

  it('reads cleanupPeriodDays defensively', () => {
    expect(readCleanupPeriodDays(homes.claudeHome)).toBeNull();
    writeFileSync(join(homes.claudeHome, 'settings.json'), '{ not json');
    expect(readCleanupPeriodDays(homes.claudeHome)).toBeNull();
    writeFileSync(join(homes.claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: '30' }));
    expect(readCleanupPeriodDays(homes.claudeHome)).toBeNull();
    writeFileSync(join(homes.claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));
    expect(readCleanupPeriodDays(homes.claudeHome)).toBe(30);
  });
});
