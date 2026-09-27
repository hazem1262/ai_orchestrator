import { isBackmergePr, type PrStatus, type StreamPr } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import { listPrStatuses } from '../db/repos/pr-cache.ts';

export interface PrSource {
  list(): StreamPr[];
}

/** P4's pr_cache has no body/base/merge time: baseRef = null, mergedAt = updatedAt for merged PRs. */
export function toStreamPr(p: PrStatus): StreamPr {
  const baseRef = null;
  return {
    pr: p.pr,
    title: p.title,
    state: p.state,
    headRef: p.headRef,
    baseRef,
    isBackmerge: isBackmergePr({ title: p.title, headRef: p.headRef, baseRef }),
    checks: p.checks,
    review: p.review,
    updatedAt: p.updatedAt,
    mergedAt: p.state === 'merged' ? p.updatedAt : null,
  };
}

/** Reads the P4 `pr_cache` that the GitHub poller keeps fresh; it never calls `gh` itself. */
export function createPrSource(ctx: DaemonContext): PrSource {
  return { list: () => listPrStatuses(ctx.db).map(toStreamPr) };
}
