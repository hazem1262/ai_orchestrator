import type { PrRef, PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus, listPrStatuses, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { listWorktrees } from '../../db/repos/worktrees.ts';
import { GitError, gh } from '../../services/git/exec.ts';
import { prRepoSlug } from '../../services/worktree/worktree-read.ts';

export type { PrStatus } from '@orc/core';

export interface GithubConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  prStatus(pr: PrRef): Promise<PrStatus>;
  myOpenPrs(): Promise<PrStatus[]>;
  poll(): Promise<void>;
  watch(pr: PrRef): void;
  start(): () => void;
}

export interface GhPrJson {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName?: string;
  updatedAt: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<Record<string, unknown>> | null;
}

export const GH_PR_FIELDS = 'number,url,title,state,headRefName,updatedAt,reviewDecision,statusCheckRollup';

const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function mapPrJson(repo: string, j: GhPrJson): PrStatus {
  const rollup = j.statusCheckRollup ?? [];
  const failed: string[] = [];
  let pending = false;
  for (const c of rollup) {
    if (c.__typename === 'StatusContext') {
      const state = str(c.state);
      if (state === 'FAILURE' || state === 'ERROR') failed.push(str(c.context));
      else if (state === 'PENDING' || state === 'EXPECTED') pending = true;
    } else {
      if (str(c.status) !== 'COMPLETED') pending = true;
      else if (FAILED_CONCLUSIONS.has(str(c.conclusion))) failed.push(str(c.name));
    }
  }
  const checks: PrStatus['checks'] =
    rollup.length === 0 ? 'none' : failed.length > 0 ? 'failure' : pending ? 'pending' : 'success';
  const review: PrStatus['review'] =
    j.reviewDecision === 'APPROVED'
      ? 'approved'
      : j.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : j.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review_required'
          : 'none';
  const state: PrStatus['state'] = j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open';
  return {
    pr: { repo, number: j.number, url: j.url },
    state,
    title: j.title,
    checks,
    review,
    updatedAt: j.updatedAt,
    headRef: j.headRefName ?? null,
    failedChecks: failed,
  };
}

const keyOf = (p: PrRef) => `${p.repo}#${p.number}`;
const signature = (s: PrStatus) => JSON.stringify([s.state, s.checks, s.review, s.failedChecks, s.updatedAt]);

/**
 * Review requests the inbox still shows as open or snoozed. The in-memory `lastRequested` starts
 * empty after a restart, so without this a PR that left the search while the daemon was down
 * would never emit `active: false` and its row would stay open forever.
 */
function openReviewRequests(ctx: DaemonContext): Map<string, PrRef & { title: string }> {
  const out = new Map<string, PrRef & { title: string }>();
  for (const item of ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['pr_event'] }) ?? []) {
    if (item.payload.event !== 'review_requested') continue;
    const pr = item.payload.pr as Partial<PrRef> | undefined;
    // Rows written by `prEventRule` end their reason with `(owner/repo#N)`.
    const m = /^Review requested: (.*) \(([^()\s]+)#(\d+)\)$/.exec(item.reason);
    const repo = typeof pr?.repo === 'string' ? pr.repo : m?.[2];
    const number = typeof pr?.number === 'number' ? pr.number : Number(m?.[3]);
    if (!repo || !Number.isInteger(number)) continue;
    const url = typeof pr?.url === 'string' ? pr.url : `https://github.com/${repo}/pull/${number}`;
    out.set(keyOf({ repo, number, url }), { repo, number, url, title: m?.[1] ?? item.reason });
  }
  return out;
}

export function createGithubConnector(ctx: DaemonContext): GithubConnector {
  const watched = new Map<string, PrRef>();
  let lastRequested = new Map<string, PrRef & { title: string }>();
  let seededRequests = false;
  let polling: Promise<void> | null = null;

  async function status(): Promise<'ok' | 'unauthenticated' | 'error'> {
    try {
      const r = await gh(['auth', 'status']);
      return r.exitCode === 0 ? 'ok' : 'unauthenticated';
    } catch {
      return 'error';
    }
  }

  async function prStatus(pr: PrRef): Promise<PrStatus> {
    const r = await gh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', GH_PR_FIELDS]);
    if (r.exitCode !== 0) {
      const code = /not logged|authenticat/i.test(r.stderr) ? 'gh_unavailable' : 'git_failed';
      throw new GitError(code, `gh pr view ${pr.repo}#${pr.number} failed: ${r.stderr.trim()}`, r.stderr);
    }
    return mapPrJson(pr.repo, JSON.parse(r.stdout) as GhPrJson);
  }

  async function myOpenRefs(): Promise<PrRef[]> {
    const r = await gh([
      'search',
      'prs',
      '--author=@me',
      '--state=open',
      '--json',
      'number,repository,url,title,updatedAt',
      '--limit',
      '50',
    ]);
    if (r.exitCode !== 0)
      throw new GitError('gh_unavailable', `gh search prs failed: ${r.stderr.trim()}`, r.stderr);
    const rows = JSON.parse(r.stdout) as Array<{
      number: number;
      url: string;
      repository: { nameWithOwner: string };
    }>;
    return rows.map((x) => ({ repo: x.repository.nameWithOwner, number: x.number, url: x.url }));
  }

  async function reviewRequestedRefs(): Promise<Array<PrRef & { title: string }>> {
    const r = await gh([
      'search',
      'prs',
      '--review-requested=@me',
      '--state=open',
      '--json',
      'number,repository,url,title',
      '--limit',
      '50',
    ]);
    if (r.exitCode !== 0)
      throw new GitError('gh_unavailable', `gh search prs failed: ${r.stderr.trim()}`, r.stderr);
    const rows = JSON.parse(r.stdout) as Array<{
      number: number;
      url: string;
      title: string;
      repository: { nameWithOwner: string };
    }>;
    return rows.map((x) => ({
      repo: x.repository.nameWithOwner,
      number: x.number,
      url: x.url,
      title: x.title,
    }));
  }

  async function myOpenPrs(): Promise<PrStatus[]> {
    const refs = await myOpenRefs();
    return Promise.all(refs.map(prStatus));
  }

  async function pollOnce(): Promise<void> {
    if (!ctx.config().github.enabled) return;
    const refs = new Map<string, PrRef>();
    try {
      for (const ref of await myOpenRefs()) refs.set(keyOf(ref), ref);
    } catch (err) {
      ctx.log.warn({ err }, 'github: listing my PRs failed');
      return;
    }
    for (const s of listPrStatuses(ctx.db, { state: 'open' })) refs.set(keyOf(s.pr), s.pr);
    for (const w of listWorktrees(ctx.db, { state: 'active' })) {
      const slug = prRepoSlug(w.prUrl);
      if (slug && w.prUrl) refs.set(`${slug.repo}#${slug.number}`, { ...slug, url: w.prUrl });
    }
    for (const [k, ref] of watched) refs.set(k, ref);

    for (const ref of refs.values()) {
      let after: PrStatus;
      try {
        after = await prStatus(ref);
      } catch (err) {
        ctx.log.warn({ err, pr: keyOf(ref) }, 'github: PR status failed');
        continue;
      }
      const before = getPrStatus(ctx.db, ref.repo, ref.number);
      if (after.state !== 'open') watched.delete(keyOf(ref));
      if (before && signature(before) === signature(after)) continue;
      upsertPrStatus(ctx.db, after, new Date().toISOString());
      ctx.bus.emit({ type: 'pr.changed', before, after });
      ctx.bus.emit({ type: 'pr.updated', status: after });
    }

    try {
      const now = new Map((await reviewRequestedRefs()).map((r) => [keyOf(r), r]));
      if (!seededRequests) {
        lastRequested = new Map([...openReviewRequests(ctx), ...lastRequested]);
        seededRequests = true;
      }
      for (const [k, r] of now) {
        if (!lastRequested.has(k))
          ctx.bus.emit({
            type: 'pr.reviewRequested',
            pr: { repo: r.repo, number: r.number, url: r.url },
            title: r.title,
            active: true,
          });
      }
      for (const [k, r] of lastRequested) {
        if (!now.has(k))
          ctx.bus.emit({
            type: 'pr.reviewRequested',
            pr: { repo: r.repo, number: r.number, url: r.url },
            title: r.title,
            active: false,
          });
      }
      lastRequested = now;
    } catch (err) {
      ctx.log.warn({ err }, 'github: listing review requests failed');
    }
  }

  function poll(): Promise<void> {
    polling ??= pollOnce().finally(() => {
      polling = null;
    });
    return polling;
  }

  function start(): () => void {
    const run = () => {
      poll().catch((err: unknown) => ctx.log.warn({ err }, 'github poll failed'));
    };
    run();
    const timer = setInterval(run, ctx.config().github.pollSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  return {
    status,
    prStatus,
    myOpenPrs,
    poll,
    watch: (pr) => {
      watched.set(keyOf(pr), pr);
    },
    start,
  };
}
