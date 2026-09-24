import { type Dirent, existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { PlanRef } from '@orc/api-contract';
import { compileTicketRegex, DEFAULT_TICKET_REGEX, redact, type Session } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { expandHome } from '../safety/secrets-scan.ts';

export interface PlanIndexEntry {
  path: string;
  title: string;
  source: PlanRef['source'];
  mtimeMs: number;
  tickets: string[];
}

export interface PlanFinderOptions {
  claudeHome: string;
  home: string;
  planRoots: () => string[];
  repoRoots: () => string[];
  ticketRegex: () => RegExp;
  maxDepth?: number;
  cacheMs?: number;
  now?: () => number;
}

export interface PlanFinder {
  index(extraRepoRoots?: string[]): Promise<PlanIndexEntry[]>;
  forSession(s: Session): Promise<PlanRef[]>;
  search(q: string, limit: number): Promise<PlanRef[]>;
  read(path: string): Promise<string | null>;
  isAllowed(path: string): boolean;
}

const HEAD_BYTES = 4096;
const MAX_READ = 512 * 1024;
const TIME_SLACK_MS = 3_600_000;
const REPO_DOC_DIRS = ['docs/superpowers/specs', 'docs/superpowers/plans'];

const within = (p: string, root: string) => p === root || p.startsWith(`${root}${sep}`);

async function walkMd(dir: string, depth: number, maxDepth: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) out.push(...(await walkMd(p, depth + 1, maxDepth)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

async function readBytes(path: string, max: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function titleOf(head: string, path: string): string {
  const m = /^#\s+(.+)$/m.exec(head);
  return (m?.[1] ?? basename(path, '.md')).trim().slice(0, 200);
}

function ticketsIn(text: string, re: RegExp): string[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...new Set([...text.matchAll(g)].map((m) => m[0].toUpperCase()))];
}

export function findRepoRoot(cwd: string, home: string): string | null {
  let dir = resolve(cwd);
  while (within(dir, home) && dir !== home) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function createPlanFinder(o: PlanFinderOptions): PlanFinder {
  const maxDepth = o.maxDepth ?? 4;
  const cacheMs = o.cacheMs ?? 30_000;
  const now = o.now ?? Date.now;
  let cached: { at: number; key: string; entries: PlanIndexEntry[] } | null = null;

  const claudePlans = () => join(o.claudeHome, 'plans');
  const planRoots = () => o.planRoots().map((r) => resolve(r));

  function roots(extra: string[]) {
    const list: Array<{ dir: string; source: PlanRef['source']; depth: number }> = [
      { dir: claudePlans(), source: 'claude-plans', depth: 0 },
    ];
    for (const r of planRoots()) list.push({ dir: r, source: 'wakecap-plans', depth: maxDepth });
    for (const repo of new Set([...o.repoRoots(), ...extra])) {
      for (const d of REPO_DOC_DIRS) list.push({ dir: join(repo, d), source: 'repo-docs', depth: 1 });
    }
    return list;
  }

  async function index(extra: string[] = []): Promise<PlanIndexEntry[]> {
    const list = roots(extra);
    const key = list.map((r) => r.dir).join('|');
    if (cached && cached.key === key && now() - cached.at < cacheMs) return cached.entries;
    const re = o.ticketRegex();
    const entries: PlanIndexEntry[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      for (const p of await walkMd(r.dir, 0, r.depth)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        const head = await readBytes(p, HEAD_BYTES).catch(() => '');
        entries.push({
          path: p,
          title: titleOf(head, p),
          source: r.source,
          mtimeMs: st.mtimeMs,
          tickets: ticketsIn(`${basename(p)}\n${head}`, re),
        });
      }
    }
    cached = { at: now(), key, entries };
    return entries;
  }

  function isAllowed(path: string): boolean {
    const p = resolve(path);
    if (!p.endsWith('.md')) return false;
    if ([claudePlans(), ...planRoots()].some((r) => p.startsWith(`${r}${sep}`))) return true;
    return (
      within(p, o.home) && REPO_DOC_DIRS.some((d) => p.includes(`${sep}${d.split('/').join(sep)}${sep}`))
    );
  }

  const toRef = (e: PlanIndexEntry, reason: PlanRef['reason']): PlanRef => ({
    path: e.path,
    title: redact(e.title),
    source: e.source,
    mtime: new Date(e.mtimeMs).toISOString(),
    reason,
    tickets: e.tickets,
  });

  const byMtimeDesc = (a: PlanRef, b: PlanRef) => (a.mtime === b.mtime ? 0 : a.mtime < b.mtime ? 1 : -1);

  return {
    index,
    async forSession(s) {
      const repos = s.cwds.map((c) => findRepoRoot(c, o.home)).filter((x): x is string => x !== null);
      const entries = await index(repos);
      const tickets = new Set(s.tickets.map((t) => t.toUpperCase()));
      const from = Date.parse(s.startedAt) - TIME_SLACK_MS;
      const to = Date.parse(s.lastActivityAt) + TIME_SLACK_MS;
      const byTicket: PlanRef[] = [];
      const byTime: PlanRef[] = [];
      for (const e of entries) {
        if (e.tickets.some((t) => tickets.has(t))) byTicket.push(toRef(e, 'ticket'));
        else if (e.source === 'claude-plans' && e.mtimeMs >= from && e.mtimeMs <= to)
          byTime.push(toRef(e, 'time'));
      }
      return [...byTicket.sort(byMtimeDesc), ...byTime.sort(byMtimeDesc)];
    },
    async search(q, limit) {
      const needle = q.trim().toLowerCase();
      const entries = await index();
      return entries
        .filter(
          (e) =>
            needle === '' ||
            e.title.toLowerCase().includes(needle) ||
            e.path.toLowerCase().includes(needle) ||
            e.tickets.some((t) => t.toLowerCase() === needle),
        )
        .map((e) => toRef(e, 'query'))
        .sort(byMtimeDesc)
        .slice(0, limit);
    },
    async read(path) {
      if (!isAllowed(path)) return null;
      const p = resolve(path);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) return null;
      return redact(await readBytes(p, Math.min(st.size, MAX_READ)));
    },
    isAllowed,
  };
}

export function createPlanFinderFromContext(
  ctx: Pick<DaemonContext, 'paths' | 'config'>,
  home: string = homedir(),
): PlanFinder {
  return createPlanFinder({
    claudeHome: ctx.paths.claudeHome,
    home,
    planRoots: () => ctx.config().links.planRoots.map((r) => expandHome(r, home)),
    repoRoots: () => ctx.config().projects.flatMap((p) => p.repos.map((r) => r.path)),
    ticketRegex: () => {
      const cfg = ctx.config();
      const project = cfg.projects.find((p) => p.id === cfg.defaultProjectId);
      return (
        compileTicketRegex(project?.ticketRegex ?? DEFAULT_TICKET_REGEX) ??
        (compileTicketRegex(DEFAULT_TICKET_REGEX) as RegExp)
      );
    },
  });
}
