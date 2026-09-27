import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PORT = 4418;
export const STATE_FILE = resolve(HERE, '../.m4-state.json');
const ROOT = resolve(HERE, '../../../..');

export interface M4State {
  dir: string;
  repo: string;
  orcHome: string;
  ghDir: string;
  pid: number;
  token: string;
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

export default async function globalSetup(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orc-m4-')));
  const repo = join(dir, 'repo');
  const orcHome = join(dir, 'orc');
  const claudeHome = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  const ghDir = join(dir, 'gh');
  for (const d of [repo, orcHome, claudeHome, codexHome, ghDir]) mkdirSync(d, { recursive: true });

  const gitEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'E2E',
    GIT_AUTHOR_EMAIL: 'e2e@example.com',
    GIT_COMMITTER_NAME: 'E2E',
    GIT_COMMITTER_EMAIL: 'e2e@example.com',
  };
  Object.assign(process.env, gitEnv);
  git(repo, 'init', '-b', 'main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  git(dir, 'init', '--bare', '-b', 'main', join(dir, 'remote.git'));
  git(repo, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  git(repo, 'push', '-u', 'origin', 'main');

  writeFileSync(
    join(ghDir, 'state.json'),
    JSON.stringify({ authed: true, repo: 'example-org/e2e-repo', nextNumber: 101, prs: {} }),
  );
  writeFileSync(join(ghDir, 'calls.jsonl'), '');
  writeFileSync(
    join(orcHome, 'config.json'),
    JSON.stringify({
      port: PORT,
      defaultProjectId: 'e2e',
      // Absolute paths to the fakes: a PATH lookup that missed the fake bin dir would start the real CLI.
      resumeProfile: {
        claudeCommand: resolve(ROOT, 'apps/web/e2e/support/bin/claude'),
        claudeArgs: ['--dangerously-skip-permissions'],
        codexCommand: resolve(ROOT, 'apps/daemon/test/bin/codex'),
      },
      projects: [
        {
          id: 'e2e',
          name: 'E2E',
          pathPrefixes: [dir],
          ticketRegex: '\\bSAF-\\d+\\b',
          repos: [{ path: repo }],
        },
      ],
      github: { enabled: true, pollSeconds: 30 },
      worktrees: { scratchpadRoots: [], autoArchiveOnMerge: true },
      archive: { enabled: false },
      // No reads outside the temp dir: the defaults point at the developer's home.
      safety: { secretScanPaths: [] },
      links: { planRoots: [] },
    }),
  );

  const bins = [resolve(ROOT, 'apps/web/e2e/support/bin'), resolve(ROOT, 'apps/daemon/test/bin')];
  const child: ChildProcess = spawn('node', [resolve(ROOT, 'apps/daemon/dist/main.js')], {
    env: {
      ...process.env,
      ...gitEnv,
      PATH: `${bins.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
      ORC_HOME: orcHome,
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      WSTACK_HOME: join(dir, 'wstack'),
      ORC_PORT: String(PORT),
      FAKE_GH_DIR: ghDir,
      E2E_DIR: dir,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const token = readFileSync(join(orcHome, 'token'), 'utf8').trim();
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'x-orc-token': token } });
      if (r.ok) {
        const state: M4State = { dir, repo, orcHome, ghDir, pid: child.pid ?? 0, token };
        writeFileSync(STATE_FILE, JSON.stringify(state));
        return;
      }
    } catch {
      // daemon not up yet
    }
    if (Date.now() > deadline) throw new Error('daemon did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
}
