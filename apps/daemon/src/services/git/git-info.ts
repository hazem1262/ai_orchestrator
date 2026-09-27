import { execa } from 'execa';

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  untracked: number;
}

export function parseShortStat(text: string): Omit<DiffStat, 'untracked'> {
  const num = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa('git', ['-C', cwd, ...args], { stdin: 'ignore' });
  return r.stdout.trim();
}

async function mergeBase(cwd: string, base: string): Promise<string> {
  return git(cwd, ['merge-base', base, 'HEAD']);
}

/** Changes since the merge-base with `base`, including uncommitted tracked edits, plus untracked file count. */
export async function diffStat(cwd: string, base: string): Promise<DiffStat> {
  const mb = await mergeBase(cwd, base);
  const short = parseShortStat(await git(cwd, ['diff', '--shortstat', mb]));
  const others = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  return { ...short, untracked: others ? others.split('\n').length : 0 };
}

/** Zero-context diff since the merge-base; used to find newly added TODO/FIXME lines. */
export async function addedLinesDiff(cwd: string, base: string): Promise<string> {
  const mb = await mergeBase(cwd, base);
  return git(cwd, ['diff', '-U0', '--no-color', mb]);
}

/** "origin/main" when origin/HEAD is known, else the first local main/master/develop, else "HEAD". */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    const ref = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (ref) return ref.replace(/^refs\/remotes\//, '');
  } catch {
    // no origin/HEAD
  }
  for (const b of ['main', 'master', 'develop']) {
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      return b;
    } catch {
      // try the next name
    }
  }
  return 'HEAD';
}

export function parseRemoteSlug(url: string): { owner: string; name: string } | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], name: m[2] };
}

export async function remoteSlug(repo: string): Promise<{ owner: string; name: string } | null> {
  try {
    return parseRemoteSlug(await git(repo, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}
