import { type PrRef, type PrStatus, ticketFromBranch } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { listWorktrees } from '../../db/repos/worktrees.ts';
import type { InboxRule } from '../engine.ts';

/** A PR's own identity; the engine composes the dedupe key from it (contracts §11). */
function prScope(pr: PrRef) {
  return { domain: 'pr', id: `${pr.repo}#${pr.number}` } as const;
}

function linkFor(ctx: DaemonContext, s: PrStatus) {
  const wt = listWorktrees(ctx.db, { state: 'active' }).find(
    (w) => w.prUrl === s.pr.url || (s.headRef !== null && w.branch === s.headRef),
  );
  return {
    cwd: wt?.path ?? null,
    sessionId: wt?.sessionPks[0] ?? null,
    projectId: wt?.projectId ?? null,
    ticket:
      wt?.ticket ?? (s.headRef ? ticketFromBranch(s.headRef, null) : null) ?? ticketFromBranch(s.title, null),
  };
}

export const prEventRule: InboxRule = {
  name: 'pr-event',
  on: ['pr.changed', 'pr.reviewRequested'],
  handle(e, ctx) {
    const inbox = ctx.inbox;
    if (!inbox) return;

    if (e.type === 'pr.reviewRequested') {
      const key = { kind: 'pr_event', scope: prScope(e.pr), facet: 'review_requested' } as const;
      if (!e.active) {
        inbox.resolve(key);
        return;
      }
      inbox.upsert({
        ...key,
        sessionId: null,
        projectId: null,
        ticket: ticketFromBranch(e.title, null),
        reason: `Review requested: ${e.title} (${e.pr.repo}#${e.pr.number})`,
        payload: {
          pr: e.pr,
          cwd: null,
          event: 'review_requested',
          presetId: null,
          vars: { prUrl: e.pr.url },
        },
      });
      return;
    }
    if (e.type !== 'pr.changed') return;

    const { before, after } = e;
    const label = `${after.pr.repo}#${after.pr.number}`;
    const scope = prScope(after.pr);
    const checksKey = { kind: 'pr_event', scope, facet: 'checks' } as const;
    const reviewKey = { kind: 'pr_event', scope, facet: 'review' } as const;

    if (after.state !== 'open') {
      if (before?.checks === 'failure') inbox.resolve(checksKey);
      if (before?.review === 'changes_requested') inbox.resolve(reviewKey);
      return;
    }

    const { cwd, ...link } = linkFor(ctx, after);
    const ticketVar = link.ticket ? { ticket: link.ticket } : {};

    if (after.checks === 'failure') {
      inbox.upsert({
        ...checksKey,
        ...link,
        reason: `CI failed on ${label}: ${after.failedChecks.join(', ') || 'unknown check'}`,
        payload: {
          pr: after.pr,
          cwd,
          event: 'checks_failed',
          failedChecks: after.failedChecks,
          headRef: after.headRef,
          presetId: 'preset-fix-ci',
          vars: { prUrl: after.pr.url, check: after.failedChecks[0] ?? '', ...ticketVar },
        },
      });
    } else if (before?.checks === 'failure') {
      inbox.resolve(checksKey);
    }

    if (after.review === 'changes_requested') {
      inbox.upsert({
        ...reviewKey,
        ...link,
        reason: `Changes requested on ${label}`,
        payload: {
          pr: after.pr,
          cwd,
          event: 'changes_requested',
          headRef: after.headRef,
          presetId: 'preset-address-comments',
          vars: { prUrl: after.pr.url, ...ticketVar },
        },
      });
    } else if (before?.review === 'changes_requested') {
      inbox.resolve(reviewKey);
    }
  },
};
