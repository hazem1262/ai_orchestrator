import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function isolateGitEnv(): void {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = 'Orc Test';
  process.env.GIT_AUTHOR_EMAIL = 'orc-test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Orc Test';
  process.env.GIT_COMMITTER_EMAIL = 'orc-test@example.com';
  process.env.GIT_TERMINAL_PROMPT = '0';
}

export interface TempRepo {
  root: string;
  dir: string;
  remote: string | null;
  git(...args: string[]): string;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  commitAll(message: string): string;
  cleanup(): void;
}

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function makeTempRepo(opts: { withRemote?: boolean } = {}): TempRepo {
  isolateGitEnv();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orc-git-')));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  run(dir, ['init', '-b', 'main']);
  run(dir, ['config', 'user.name', 'Orc Test']);
  run(dir, ['config', 'user.email', 'orc-test@example.com']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  const write = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  write('README.md', '# temp\n');
  write('src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  write('.gitignore', '.env\nnode_modules/\n.worktrees/\n');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-m', 'initial']);
  let remote: string | null = null;
  if (opts.withRemote) {
    remote = join(root, 'remote.git');
    run(root, ['init', '--bare', '-b', 'main', remote]);
    run(dir, ['remote', 'add', 'origin', remote]);
    run(dir, ['push', '-u', 'origin', 'main']);
  }
  return {
    root,
    dir,
    remote,
    git: (...args) => run(dir, args),
    write,
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
    exists: (rel) => existsSync(join(dir, rel)),
    commitAll: (message) => {
      run(dir, ['add', '-A']);
      run(dir, ['commit', '-m', message]);
      return run(dir, ['rev-parse', 'HEAD']).trim();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
