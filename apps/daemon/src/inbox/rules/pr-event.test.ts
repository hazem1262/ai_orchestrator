import type { PrStatus } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext } from '../../../test/helpers.ts';
import { recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { upsertWorktree } from '../../db/repos/worktrees.ts';
import type { BusEvent } from '../../live/event-bus.ts';
import { inboxDedupeKey } from '../dedupe-key.ts';
import { prEventRule } from './pr-event.ts';

const pr = { repo: 'o/r', number: 4, url: 'https://github.com/o/r/pull/4' };
const prScope = { domain: 'pr', id: 'o/r#4' } as const;
const prItemKey = (facet: 'checks' | 'review') => inboxDedupeKey({ kind: 'pr_event', scope: prScope, facet });
const status = (p: Partial<PrStatus> = {}): PrStatus => ({
  pr,
  state: 'open',
  title: 'SAF-44 thing',
  checks: 'pending',
  review: 'review_required',
  updatedAt: '2026-09-17T10:00:00Z',
  headRef: 'feat/SAF-44-thing',
  failedChecks: [],
  ...p,
});

let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
});

function setup() {
  const inbox = recordingInbox();
  const ctx = createTestContext({ inbox, sessions: stubSessions([]) });
  disposers.push(() => ctx.dispose());
  upsertWorktree(ctx.db, {
    path: '/r/.worktrees/feat-SAF-44-thing',
    repo: '/r',
    branch: 'feat/SAF-44-thing',
    base: 'main',
    ticket: 'SAF-44',
    dirty: false,
    prUrl: pr.url,
    state: 'active',
    createdByApp: true,
    head: null,
    isMain: false,
    origin: 'app',
    sessionPks: ['claude:s44'],
    projectId: 'wakecap',
    createdAt: '2026-09-17T09:00:00Z',
    updatedAt: '2026-09-17T09:00:00Z',
    archivedAt: null,
  });
  const fire = (e: BusEvent) => prEventRule.handle(e, ctx);
  return { inbox, fire };
}

describe('prEventRule', () => {
  it('opens a checks item with the failing checks and the fix-CI preset', () => {
    const { inbox, fire } = setup();
    fire({
      type: 'pr.changed',
      before: status(),
      after: status({ checks: 'failure', failedChecks: ['unit', 'lint'] }),
    });
    expect(inbox.upserts).toEqual([
      {
        kind: 'pr_event',
        scope: prScope,
        facet: 'checks',
        sessionId: 'claude:s44',
        projectId: 'wakecap',
        ticket: 'SAF-44',
        reason: 'CI failed on o/r#4: unit, lint',
        payload: {
          pr,
          cwd: '/r/.worktrees/feat-SAF-44-thing',
          event: 'checks_failed',
          failedChecks: ['unit', 'lint'],
          headRef: 'feat/SAF-44-thing',
          presetId: 'preset-fix-ci',
          vars: { prUrl: pr.url, check: 'unit', ticket: 'SAF-44' },
        },
      },
    ]);
  });

  it('resolves the checks item when checks recover and opens a review item on changes requested', () => {
    const { inbox, fire } = setup();
    fire({
      type: 'pr.changed',
      before: status({ checks: 'failure' }),
      after: status({ checks: 'success', review: 'changes_requested' }),
    });
    expect(inbox.resolved).toEqual([prItemKey('checks')]);
    expect(inbox.upserts[0]).toMatchObject({
      scope: prScope,
      facet: 'review',
      reason: 'Changes requested on o/r#4',
      payload: { event: 'changes_requested', presetId: 'preset-address-comments' },
    });
  });

  it('resolves everything when the PR merges', () => {
    const { inbox, fire } = setup();
    fire({
      type: 'pr.changed',
      before: status({ checks: 'failure', review: 'changes_requested' }),
      after: status({ state: 'merged', checks: 'success', review: 'approved' }),
    });
    expect(inbox.upserts).toEqual([]);
    expect(inbox.resolved.sort()).toEqual([prItemKey('checks'), prItemKey('review')].sort());
  });

  it('does nothing for a first sighting that is healthy', () => {
    const { inbox, fire } = setup();
    fire({ type: 'pr.changed', before: null, after: status() });
    expect(inbox.upserts).toEqual([]);
    expect(inbox.resolved).toEqual([]);
  });

  it('tracks review requests from other people', () => {
    const { inbox, fire } = setup();
    const other = { repo: 'o/x', number: 9, url: 'https://github.com/o/x/pull/9' };
    const otherScope = { domain: 'pr', id: 'o/x#9' } as const;
    fire({ type: 'pr.reviewRequested', pr: other, title: 'TAN-9 new api', active: true });
    expect(inbox.upserts[0]).toMatchObject({
      kind: 'pr_event',
      scope: otherScope,
      facet: 'review_requested',
      ticket: 'TAN-9',
      sessionId: null,
      reason: 'Review requested: TAN-9 new api (o/x#9)',
      payload: { event: 'review_requested', presetId: null },
    });
    fire({ type: 'pr.reviewRequested', pr: other, title: 'TAN-9 new api', active: false });
    expect(inbox.resolved).toEqual([
      inboxDedupeKey({ kind: 'pr_event', scope: otherScope, facet: 'review_requested' }),
    ]);
  });
});
