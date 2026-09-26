import { execa } from 'execa';

export class GitError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(code: string, message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PUSH_FORBIDDEN = new Set([
  '--force',
  '-f',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '-d',
  '--prune',
]);

export function assertSafeGitArgs(args: readonly string[]): void {
  const [cmd, ...rest] = args;
  const deny = (why: string) => {
    throw new GitError('forbidden_git_args', `refused git ${args.join(' ')}: ${why}`);
  };
  if (cmd === 'push') {
    for (const a of rest) {
      if (PUSH_FORBIDDEN.has(a) || a.startsWith('--force') || a.startsWith('+') || a.includes(':+'))
        deny('force or destructive push');
      if (a.startsWith(':')) deny('ref deletion');
    }
  }
  if (cmd === 'reset' && rest.includes('--hard')) deny('hard reset');
  if (cmd === 'clean') deny('git clean');
  if (cmd === 'worktree' && rest[0] === 'remove' && (rest.includes('--force') || rest.includes('-f')))
    deny('forced worktree removal');
  if (cmd === 'checkout' && rest.includes('--'))
    deny('checkout of paths discards changes; use restore with a checkpoint');
  if (cmd === 'branch' && (rest.includes('-D') || rest.includes('--delete') || rest.includes('-d')))
    deny('branch deletion');
  if (cmd === 'stash' && rest[0] !== 'list') deny('stash is never touched');
  if (cmd === 'update-ref') {
    const ref = rest.find((a) => !a.startsWith('-'));
    if (!ref?.startsWith('refs/orchestrator/')) deny('only refs/orchestrator/* may be updated');
  }
}

const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

export async function git(
  cwd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {},
): Promise<ExecResult> {
  assertSafeGitArgs(args);
  const r = await execa('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    reject: false,
    stripFinalNewline: false,
    env: { ...BASE_ENV, ...opts.env },
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });
  const res: ExecResult = {
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    exitCode: r.exitCode ?? 1,
  };
  if (res.exitCode !== 0 && !opts.allowFail) {
    throw new GitError('git_failed', `git ${args[0] ?? ''} failed: ${res.stderr.trim()}`, res.stderr);
  }
  return res;
}

export async function gitOut(
  cwd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  const r = await git(cwd, args, opts);
  return r.stdout.replace(/\n$/, '');
}

export async function gh(
  args: readonly string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<ExecResult> {
  try {
    const r = await execa('gh', [...args], {
      reject: false,
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  } catch (err) {
    throw new GitError('gh_unavailable', `gh could not be started: ${(err as Error).message}`);
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function mainCheckoutOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['worktree', 'list', '--porcelain'], { allowFail: true }).catch(() => null);
  if (r?.exitCode !== 0) return null;
  const first = r.stdout.split('\n').find((l) => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : null;
}
