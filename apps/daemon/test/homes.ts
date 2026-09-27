import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OrcPaths, resolvePaths } from '../src/config.ts';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const FAKE_BIN_DIR = fileURLToPath(new URL('./bin/', import.meta.url));
export const FAKE_CLAUDE = join(FAKE_BIN_DIR, 'claude');
export const FIXTURE_USER_HOME = '/Users/test';

export interface TempHomes {
  root: string;
  orcHome: string;
  claudeHome: string;
  codexHome: string;
  wstackHome: string;
  userHome: string;
  paths: OrcPaths;
  env: Record<string, string>;
  cleanup(): void;
}

/** `root` pins the temp homes to a known path; anything already there is removed first. Without it
 *  every call gets a fresh `mkdtemp`. `env.WSTACK_HOME` is an empty temp workflows home, for a
 *  daemon process started on `env` (the process env of the test run itself is set by `setup-env.ts`). */
export function makeTempHomes(opts: { root?: string } = {}): TempHomes {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'orc-test-'));
  if (opts.root) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  }
  const orcHome = join(root, 'orc');
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  cpSync(join(FIXTURES_DIR, 'claude-home'), claudeHome, { recursive: true });
  cpSync(join(FIXTURES_DIR, 'codex-home'), codexHome, { recursive: true });
  const wstackHome = join(root, 'wstack');
  mkdirSync(orcHome, { recursive: true });
  mkdirSync(join(wstackHome, 'workflows'), { recursive: true });
  const env = {
    ORC_HOME: orcHome,
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
    WSTACK_HOME: wstackHome,
    ORC_USER_HOME: FIXTURE_USER_HOME,
  };
  return {
    root,
    orcHome,
    claudeHome,
    codexHome,
    wstackHome,
    userHome: FIXTURE_USER_HOME,
    paths: resolvePaths(env),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The fixture e2e daemon's root: `ORC_E2E_ROOT` when the Playwright config pinned one (its specs
 * compute the launch directory from it), else a fresh `mkdtemp`, so two e2e servers never share
 * (and tear down) each other's homes. Resolved through realpath because a launched child reports
 * its physical cwd on macOS.
 */
export function e2eRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORC_E2E_ROOT ?? realpathSync(mkdtempSync(join(tmpdir(), 'orc-e2e-')));
}

/** Writes a minimal resumable transcript whose cwd exists on disk (fixture cwds do not). */
export function writeClaudeSession(
  h: TempHomes,
  o: { sessionId: string; cwd: string; prompt: string; timestamp?: string },
): string {
  mkdirSync(o.cwd, { recursive: true });
  const dir = join(h.claudeHome, 'projects', o.cwd.replace(/[/._ ]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${o.sessionId}.jsonl`);
  const rec = {
    type: 'user',
    uuid: `${o.sessionId}-u1`,
    parentUuid: null,
    isSidechain: false,
    sessionId: o.sessionId,
    timestamp: o.timestamp ?? new Date().toISOString(),
    cwd: o.cwd,
    message: { role: 'user', content: o.prompt },
  };
  writeFileSync(file, `${JSON.stringify(rec)}\n`);
  return file;
}
