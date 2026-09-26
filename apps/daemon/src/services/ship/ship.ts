import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRequest } from '@orc/api-contract';
import { type PrRef, redact, ticketFromBranch } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { defaultBase } from '../diff/diff.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, gh, git, gitOut, repoRoot } from '../git/exec.ts';

export interface ShipSuggestionResult {
  message: string;
  title: string;
  body: string;
  base: string;
  branch: string;
  ticket: string | null;
}

export interface ShipService {
  commit(cwd: string, message: string): Promise<{ sha: string }>;
  push(cwd: string): Promise<void>;
  createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef>;
  merge(pr: PrRef, method: 'merge' | 'squash' | 'rebase'): Promise<void>;
  suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult>;
  backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }>;
}

export type Launcher = (req: LaunchRequest) => Promise<{ ptyId: string; sessionId: string | null }>;

export const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
] as const;

export async function readPrTemplate(root: string): Promise<string | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    const p = join(root, rel);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

export async function currentBranch(cwd: string): Promise<string> {
  const b = await gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (b === 'HEAD') throw new GitError('protected_branch', 'detached HEAD: check out a branch first');
  return b;
}

const firstSentence = (text: string) =>
  (text.split(/(?<=[.!?])\s|\n/)[0] ?? '')
    .replace(/[.!?]$/, '')
    .trim()
    .slice(0, 72);

const SUMMARY_HEADING = /^##[ \t]+Summary[ \t]*$/im;

/** Puts the summary under the template's own `## Summary` heading, or prepends one when it has none. */
function withSummary(template: string | null, text: string): string {
  if (!template) return `## Summary\n\n${text}\n`;
  const body = template.trimEnd();
  const m = SUMMARY_HEADING.exec(body);
  if (!m) return `## Summary\n\n${text}\n\n${body}\n`;
  const end = m.index + m[0].length;
  return `${body.slice(0, end)}\n\n${text}\n${body.slice(end)}\n`;
}

export function createShipService(ctx: DaemonContext, opts: { launch?: Launcher } = {}): ShipService {
  // SUPERSEDED CALL SHAPE: the plan's `launchSession(ctx, req)` does not exist; the shipped P2
  // launcher is `ctx.launcher.launch(req)` (services/launch.ts).
  const launch: Launcher =
    opts.launch ??
    ((req) => {
      if (!ctx.launcher) throw new Error('launch service missing');
      return ctx.launcher.launch(req);
    });

  async function rootOf(cwd: string): Promise<string> {
    const root = await repoRoot(cwd);
    if (!root) throw new GitError('not_a_worktree', `${cwd} is not inside a git checkout`);
    return root;
  }

  async function assertNotProtected(root: string): Promise<string> {
    const branch = await currentBranch(root);
    if (ctx.config().github.protectedBranches.includes(branch)) {
      throw new GitError('protected_branch', `refusing to commit or push directly to ${branch}`);
    }
    return branch;
  }

  async function commit(cwd: string, message: string): Promise<{ sha: string }> {
    return runAudited(ctx, 'user', 'git.commit', cwd, { message }, async () => {
      const root = await rootOf(cwd);
      await assertNotProtected(root);
      await gitOut(root, ['add', '-A']);
      const staged = await git(root, ['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.exitCode === 0) throw new GitError('nothing_to_commit', 'there are no changes to commit');
      await gitOut(root, ['commit', '-m', message]);
      return { sha: await gitOut(root, ['rev-parse', 'HEAD']) };
    });
  }

  async function push(cwd: string): Promise<void> {
    await runAudited(ctx, 'user', 'git.push', cwd, {}, async () => {
      const root = await rootOf(cwd);
      const branch = await assertNotProtected(root);
      const r = await git(root, ['push', '-u', 'origin', branch], { allowFail: true });
      if (r.exitCode !== 0) {
        const rejected = /rejected|non-fast-forward|fetch first/i.test(r.stderr);
        throw new GitError(
          rejected ? 'push_rejected' : 'git_failed',
          rejected ? `push rejected: pull and reconcile ${branch} first` : r.stderr.trim(),
          r.stderr,
        );
      }
    });
  }

  async function createPr(
    cwd: string,
    i: { title: string; body: string; base: string; draft?: boolean },
  ): Promise<PrRef> {
    return runAudited(
      ctx,
      'user',
      'pr.create',
      cwd,
      { title: i.title, base: i.base, draft: i.draft ?? false },
      async () => {
        const root = await rootOf(cwd);
        const branch = await assertNotProtected(root);
        const dir = mkdtempSync(join(tmpdir(), 'orc-pr-'));
        try {
          const bodyFile = join(dir, 'body.md');
          writeFileSync(bodyFile, i.body);
          const args = [
            'pr',
            'create',
            '--title',
            i.title,
            '--body-file',
            bodyFile,
            '--base',
            i.base,
            '--head',
            branch,
          ];
          if (i.draft) args.push('--draft');
          const r = await gh(args, { cwd: root });
          if (r.exitCode !== 0)
            throw new GitError('git_failed', `gh pr create failed: ${r.stderr.trim()}`, r.stderr);
          const url = r.stdout.trim().split('\n').pop() ?? '';
          const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
          if (!m?.[1] || !m[2])
            throw new GitError('git_failed', `could not read the PR URL from gh output: ${url}`);
          const pr: PrRef = { repo: m[1], number: Number(m[2]), url };
          const wt = ctx.worktrees?.findByCwd(root) ?? null;
          const row = wt ? getWorktree(ctx.db, wt.path) : null;
          if (row) {
            upsertWorktree(ctx.db, { ...row, prUrl: url, updatedAt: new Date().toISOString() });
            const view = ctx.worktrees?.get(row.path);
            if (view) ctx.bus.emit({ type: 'worktree.updated', worktree: view });
          }
          ctx.github?.watch(pr);
          return pr;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }

  async function merge(pr: PrRef, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
    await runAudited(ctx, 'user', 'pr.merge', `${pr.repo}#${pr.number}`, { method }, async () => {
      const r = await gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, `--${method}`]);
      if (r.exitCode !== 0)
        throw new GitError('git_failed', `gh pr merge failed: ${r.stderr.trim()}`, r.stderr);
    });
    ctx.github?.watch(pr);
    await ctx.github?.poll();
  }

  async function suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult> {
    const root = await rootOf(cwd);
    const branch = await currentBranch(root);
    const wt = ctx.worktrees?.findByCwd(root) ?? null;
    const ticket = wt?.ticket ?? ticketFromBranch(branch, null);
    const type = /^(feat|fix|chore|docs|refactor)\//.exec(branch)?.[1] ?? 'chore';
    const base = wt?.base ?? (await defaultBase(root)).replace(/^origin\//, '');
    const session = sessionPk ? ctx.sessions.getByPk(sessionPk) : null;
    const recap = session?.recap ? redact(session.recap) : null;
    const slugWords = branch
      .replace(/^[^/]+\//, '')
      .replace(/^[A-Za-z][A-Za-z0-9]*-\d+-?/, '')
      .replace(/-/g, ' ')
      .trim();
    const summary = recap ? firstSentence(recap) : slugWords || 'update';
    const subject = ticket ? `${ticket} ${summary}` : summary;
    const ticketUrl = ticket ? ctx.config().github.ticketUrlTemplate.replace('{ticket}', ticket) : null;
    const template = await readPrTemplate(root);
    const footer = ticketUrl ? `\n---\nTicket: [${ticket}](${ticketUrl})\n` : '';
    const body = `${withSummary(template, recap ?? summary)}${footer}`;
    return { message: `${type}: ${subject}`, title: subject, body, base, branch, ticket };
  }

  async function backmerge(
    cwd: string,
    projectId: string,
    ticket: string | null,
  ): Promise<{ ptyId: string }> {
    return runAudited(ctx, 'user', 'ship.backmerge', cwd, { projectId, ticket }, async () => {
      if (!ctx.templates) throw new Error('template registry missing');
      const vars: Record<string, string> = ticket ? { ticket } : {};
      const prompt = ctx.templates.render('backmerge', vars);
      const req = LaunchRequest.parse({
        source: 'claude',
        projectId,
        cwd,
        prompt,
        templateId: 'backmerge',
        vars,
        ...(ticket ? { ticket } : {}),
      });
      const { ptyId } = await launch(req);
      return { ptyId };
    });
  }

  return { commit, push, createPr, merge, suggest, backmerge };
}
