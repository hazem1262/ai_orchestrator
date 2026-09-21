import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { agentIdFromPath } from '@orc/core';
import type { OrcPaths } from '../config.ts';

export type IndexedFileKind =
  | 'claude-main'
  | 'claude-subagent'
  | 'claude-subagent-meta'
  | 'claude-history'
  | 'codex-rollout';

export interface ClassifiedFile {
  kind: IndexedFileKind;
  sessionId: string | null;
  agentId: string | null;
}

const ROLLOUT = /^rollout-.*\.jsonl$/;

/**
 * Classifies a path under `CLAUDE_HOME`/`CODEX_HOME` into what the indexer should do with it, or
 * `null` for anything it should ignore (registry `*.key` files, tool-results, scratch dirs, etc).
 */
export function classifyPath(path: string, paths: OrcPaths): ClassifiedFile | null {
  if (path.endsWith('.key')) return null;
  if (path === join(paths.claudeHome, 'history.jsonl')) {
    return { kind: 'claude-history', sessionId: null, agentId: null };
  }
  const projectsDir = `${join(paths.claudeHome, 'projects')}${sep}`;
  if (path.startsWith(projectsDir)) {
    const rel = path.slice(projectsDir.length).split(sep);
    const [, second, third, fourth] = rel;
    if (rel.length === 2 && second?.endsWith('.jsonl')) {
      return { kind: 'claude-main', sessionId: basename(second, '.jsonl'), agentId: null };
    }
    if (rel.length === 4 && second && third === 'subagents' && fourth) {
      const agentId = agentIdFromPath(fourth);
      if (!agentId) return null;
      if (fourth.endsWith('.jsonl')) return { kind: 'claude-subagent', sessionId: second, agentId };
      if (fourth.endsWith('.meta.json')) return { kind: 'claude-subagent-meta', sessionId: second, agentId };
    }
    return null;
  }
  const codexDir = `${join(paths.codexHome, 'sessions')}${sep}`;
  if (path.startsWith(codexDir) && ROLLOUT.test(basename(path))) {
    return { kind: 'codex-rollout', sessionId: null, agentId: null };
  }
  return null;
}

function dirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every file the indexer should read at startup, in indexing order: Claude main transcripts,
 * then subagent transcripts (parents are indexed first so `hasSubagents` and agent parenting are
 * already known), then Codex rollouts, then `history.jsonl` last (so it never races ahead of the
 * transcripts it must not clobber). Each group is sorted for a deterministic scan order.
 */
export function listIndexableFiles(paths: OrcPaths): string[] {
  const main: string[] = [];
  const subs: string[] = [];
  const codex: string[] = [];
  const projectsDir = join(paths.claudeHome, 'projects');
  for (const d of dirents(projectsDir)) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsDir, d.name);
    for (const f of dirents(dir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        main.push(join(dir, f.name));
      } else if (f.isDirectory()) {
        const subDir = join(dir, f.name, 'subagents');
        for (const s of dirents(subDir)) {
          if (s.isFile() && /^agent-.+\.jsonl$/.test(s.name)) subs.push(join(subDir, s.name));
        }
      }
    }
  }
  const walk = (dir: string): void => {
    for (const d of dirents(dir)) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && ROLLOUT.test(d.name)) codex.push(p);
    }
  };
  walk(join(paths.codexHome, 'sessions'));
  const history = join(paths.claudeHome, 'history.jsonl');
  return [...main.sort(), ...subs.sort(), ...codex.sort(), ...(existsSync(history) ? [history] : [])];
}
