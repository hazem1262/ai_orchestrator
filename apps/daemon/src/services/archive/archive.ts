import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Source } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { sessionPk } from '../../db/keys.ts';
import {
  type ArchiveEntry,
  archiveTotals,
  getArchiveEntry,
  upsertArchiveEntry,
} from '../../db/repos/archive.ts';
import { readHeadFingerprint } from '../../indexer/indexer.ts';
import { type ArchiveCodec, availableCodec, codecExtension, compressBuffer } from './compress.ts';

export interface TranscriptFile {
  path: string;
  sessionId: string;
  agentId: string | null;
  size: number;
  mtimeMs: number;
}

export interface ArchiveService {
  syncAll(): Promise<{ copied: number }>;
  status(): {
    enabled: boolean;
    files: number;
    bytes: number;
    oldestTranscript: string | null;
    cleanupPeriodDays: number | null;
  };
  restore(source: Source, id: string): Promise<void>;
}

export interface ArchiveServiceRuntime extends ArchiveService {
  restorePlan(source: Source, id: string): { targets: string[] };
  codec(): ArchiveCodec;
  start(intervalMs?: number): void;
  stop(): void;
}

export class ArchiveError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const safeStat = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

export function listClaudeTranscripts(claudeHome: string): TranscriptFile[] {
  const root = join(claudeHome, 'projects');
  const out: TranscriptFile[] = [];
  for (const dirName of safeReaddir(root)) {
    const dir = join(root, dirName);
    if (!safeStat(dir)?.isDirectory()) continue;
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      const st = safeStat(p);
      if (!st) continue;
      if (st.isFile() && name.endsWith('.jsonl')) {
        out.push({
          path: p,
          sessionId: name.slice(0, -'.jsonl'.length),
          agentId: null,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } else if (st.isDirectory()) {
        const subDir = join(p, 'subagents');
        for (const sub of safeReaddir(subDir)) {
          const m = /^agent-(.+)\.jsonl$/.exec(sub);
          if (!m?.[1]) continue;
          const sp = join(subDir, sub);
          const sst = safeStat(sp);
          if (sst?.isFile()) {
            out.push({ path: sp, sessionId: name, agentId: m[1], size: sst.size, mtimeMs: sst.mtimeMs });
          }
        }
      }
    }
  }
  return out;
}

/** Reads only `cleanupPeriodDays` from ~/.claude/settings.json (read-only). */
export function readCleanupPeriodDays(claudeHome: string): number | null {
  try {
    const v = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')) as {
      cleanupPeriodDays?: unknown;
    };
    return typeof v.cleanupPeriodDays === 'number' && Number.isFinite(v.cleanupPeriodDays)
      ? v.cleanupPeriodDays
      : null;
  } catch {
    return null;
  }
}

export function createArchiveService(
  ctx: DaemonContext,
  opts: { codec?: ArchiveCodec; now?: () => Date } = {},
): ArchiveServiceRuntime {
  const codec = opts.codec ?? availableCodec();
  const now = opts.now ?? (() => new Date());
  let inFlight: Promise<{ copied: number }> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let endedTimer: NodeJS.Timeout | null = null;
  let unsub: (() => void) | null = null;

  const projectFor = (sessionId: string): string =>
    ctx.sessions.getByPk(sessionPk('claude', sessionId))?.projectId ?? '_unassigned';

  const archivePathFor = (projectId: string, f: TranscriptFile): string => {
    const ext = `.jsonl${codecExtension(codec)}`;
    return f.agentId
      ? join(ctx.paths.archiveDir, projectId, f.sessionId, 'subagents', `agent-${f.agentId}${ext}`)
      : join(ctx.paths.archiveDir, projectId, `${f.sessionId}${ext}`);
  };

  /**
   * A grown source is copied and a shrunk one never is. At equal size the head fingerprint
   * decides, so a same-size rewrite is copied even when the mtime was put back; a row with no
   * fingerprint yet counts as unchanged.
   */
  async function needsCopy(f: TranscriptFile, prev: ArchiveEntry | null): Promise<boolean> {
    if (!prev || f.size > prev.sourceSize) return true;
    if (f.size < prev.sourceSize) {
      ctx.log.warn({ path: f.path }, 'transcript shrank; keeping the archived copy');
      return false;
    }
    if (prev.headFingerprint === null) return false;
    return (await readHeadFingerprint(f.path, f.size)) !== prev.headFingerprint;
  }

  async function copyOne(f: TranscriptFile, prev: ArchiveEntry | null): Promise<void> {
    const buf = await readFile(f.path);
    const headFingerprint = await readHeadFingerprint(f.path, buf.length);
    const packed = await compressBuffer(buf, codec);
    const target =
      prev && prev.codec === codec ? prev.archivePath : archivePathFor(projectFor(f.sessionId), f);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, packed, { mode: 0o600 });
    await rename(tmp, target);
    if (prev && prev.archivePath !== target && prev.archivePath.startsWith(ctx.paths.archiveDir)) {
      await rm(prev.archivePath, { force: true });
    }
    upsertArchiveEntry(ctx.db, {
      path: f.path,
      sessionPk: sessionPk('claude', f.sessionId),
      agentId: f.agentId,
      projectId: prev?.projectId ?? projectFor(f.sessionId),
      archivePath: target,
      codec,
      sourceSize: buf.length,
      sourceMtimeMs: Math.trunc(f.mtimeMs),
      bytes: packed.length,
      archivedAt: now().toISOString(),
      headFingerprint,
    });
  }

  async function runSync(): Promise<{ copied: number }> {
    const cfg = ctx.config();
    if (!cfg.archive.enabled) return { copied: 0 };
    let copied = 0;
    for (const f of listClaudeTranscripts(ctx.paths.claudeHome)) {
      try {
        const prev = getArchiveEntry(ctx.db, f.path);
        if (!(await needsCopy(f, prev))) continue;
        await copyOne(f, prev);
        copied++;
      } catch (err) {
        ctx.log.warn({ err: String(err), path: f.path }, 'archive copy failed');
      }
    }
    const totals = archiveTotals(ctx.db);
    if (totals.bytes > cfg.archive.maxGb * 1024 ** 3) {
      ctx.log.warn(
        { bytes: totals.bytes, maxGb: cfg.archive.maxGb },
        'archive is over its size limit (pruning is not automatic)',
      );
    }
    return { copied };
  }

  const svc: ArchiveServiceRuntime = {
    syncAll() {
      if (!inFlight) {
        inFlight = runSync().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },

    status() {
      const totals = archiveTotals(ctx.db);
      let oldest: number | null = null;
      for (const f of listClaudeTranscripts(ctx.paths.claudeHome)) {
        if (f.agentId === null && (oldest === null || f.mtimeMs < oldest)) oldest = f.mtimeMs;
      }
      return {
        enabled: ctx.config().archive.enabled,
        files: totals.files,
        bytes: totals.bytes,
        oldestTranscript: oldest === null ? null : new Date(oldest).toISOString(),
        cleanupPeriodDays: readCleanupPeriodDays(ctx.paths.claudeHome),
      };
    },

    restorePlan() {
      throw new ArchiveError(400, 'not_ready', 'restore is implemented in the next task');
    },

    async restore() {
      throw new ArchiveError(400, 'not_ready', 'restore is implemented in the next task');
    },

    codec: () => codec,

    start(intervalMs = 600_000) {
      void svc.syncAll();
      timer = setInterval(() => void svc.syncAll(), intervalMs);
      timer.unref();
      unsub = ctx.bus.on('session.statusChanged', (e) => {
        if (e.to !== 'ended') return;
        if (endedTimer) clearTimeout(endedTimer);
        endedTimer = setTimeout(() => void svc.syncAll(), 5000);
        endedTimer.unref();
      });
    },

    stop() {
      if (timer) clearInterval(timer);
      if (endedTimer) clearTimeout(endedTimer);
      timer = null;
      endedTimer = null;
      unsub?.();
      unsub = null;
    },
  };
  return svc;
}
