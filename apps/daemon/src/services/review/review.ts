import {
  buildReviewPrompt,
  type LiveState,
  type PrStatus,
  type ReviewComment,
  type ReviewSummary,
  redact,
  type Session,
  type Source,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus } from '../../db/repos/pr-cache.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, repoRoot } from '../git/exec.ts';
import { sessionPk } from '../sessions.ts';

export interface ReviewService {
  summary(source: Source, id: string): Promise<ReviewSummary>;
  sendComments(
    source: Source,
    id: string,
    comments: ReviewComment[],
    deliver: 'session' | 'text',
  ): Promise<{ sent: boolean; text: string }>;
}

export function isOwned(s: Session): s is Session & { live: LiveState & { ptyId: string } } {
  return s.live?.ownership === 'owned' && typeof s.live.ptyId === 'string' && s.live.ptyId !== '';
}

export function sessionWorkdir(s: Session): string {
  return s.cwds[s.cwds.length - 1] ?? s.startCwd;
}

export function createReviewService(ctx: DaemonContext): ReviewService {
  function load(source: Source, id: string): Session {
    const s = ctx.sessions.get(source, id);
    if (!s) throw new GitError('not_found', `session ${source}:${id} not found`);
    return s;
  }

  function prFor(s: Session, fromWorktree: PrStatus | null): PrStatus | null {
    if (fromWorktree) return fromWorktree;
    const ref = s.prs[s.prs.length - 1];
    return ref ? getPrStatus(ctx.db, ref.repo, ref.number) : null;
  }

  async function summary(source: Source, id: string): Promise<ReviewSummary> {
    const s = load(source, id);
    const pk = sessionPk(source, id);
    const workdir = sessionWorkdir(s);
    const wt = ctx.worktrees?.findByCwd(workdir) ?? null;
    const cwd = wt?.path ?? (await repoRoot(workdir));
    if (!cwd) throw new GitError('no_worktree', `${workdir} is not inside a git checkout`);
    if (!ctx.diff) throw new Error('diff service missing');
    const d = await ctx.diff.diff(cwd);
    const recapSource = s.recap ?? null;
    return {
      sessionPk: pk,
      cwd,
      worktree: wt,
      files: d.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      additions: d.additions,
      deletions: d.deletions,
      lastTest: s.lastTest,
      recap: recapSource === null ? null : redact(recapSource),
      pr: prFor(s, wt?.prStatus ?? null),
      owned: isOwned(s),
      checkpoints: ctx.checkpoints?.list(pk) ?? [],
    };
  }

  async function sendComments(
    source: Source,
    id: string,
    comments: ReviewComment[],
    deliver: 'session' | 'text',
  ) {
    const s = load(source, id);
    const pk = sessionPk(source, id);
    const wt = ctx.worktrees?.findByCwd(sessionWorkdir(s)) ?? null;
    const text = buildReviewPrompt(comments, { branch: wt?.branch ?? null });
    if (deliver === 'text' || !isOwned(s)) return { sent: false, text };
    const ptyId = s.live.ptyId;
    await runAudited(ctx, 'user', 'review.send', pk, { comments: comments.length, ptyId }, () =>
      ctx.pty.sendText(ptyId, text),
    );
    return { sent: true, text };
  }

  return { summary, sendComments };
}
