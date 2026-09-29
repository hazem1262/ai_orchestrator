import { OrcConfig } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, type FakePr, useFakeGh } from '../../../test/fake-gh.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { getPrStatus, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { prEventRule } from '../../inbox/rules/pr-event.ts';
import { createGithubConnector, mapPrJson } from './github.ts';

let fake: FakeGh;
const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  fake?.restore();
});

const fakePr = (p: Partial<FakePr> = {}): FakePr => ({
  repo: 'example-org/temp-repo',
  number: 7,
  url: 'https://github.com/example-org/temp-repo/pull/7',
  title: 'SAF-1 thing',
  state: 'OPEN',
  headRefName: 'feat/SAF-1-thing',
  baseRefName: 'main',
  body: '',
  updatedAt: '2026-09-17T10:00:00Z',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [],
  ...p,
});

function setup(
  initial: Parameters<typeof useFakeGh>[0] = {},
  github = {},
  inbox?: ReturnType<typeof recordingInbox>,
) {
  fake = useFakeGh(initial);
  const cfg = OrcConfig.parse({ github });
  const ctx = createTestContext({ config: () => cfg, sessions: stubSessions([]), inbox });
  contexts.push(ctx);
  const changes: Array<{ before: PrStatus | null; after: PrStatus }> = [];
  ctx.bus.on('pr.changed', (e) => changes.push({ before: e.before, after: e.after }));
  return { ctx, gh: createGithubConnector(ctx), changes };
}

describe('mapPrJson', () => {
  const base = { number: 1, url: 'u', title: 't', state: 'OPEN', headRefName: 'h', updatedAt: 'x' };
  it('maps failing, pending, passing and missing checks', () => {
    expect(
      mapPrJson('o/r', {
        ...base,
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'StatusContext', context: 'lint', state: 'ERROR' },
          { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
        ],
      }),
    ).toMatchObject({ checks: 'failure', failedChecks: ['unit', 'lint'] });
    expect(
      mapPrJson('o/r', {
        ...base,
        statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }],
      }).checks,
    ).toBe('pending');
    expect(
      mapPrJson('o/r', {
        ...base,
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }).checks,
    ).toBe('success');
    expect(mapPrJson('o/r', { ...base, statusCheckRollup: null }).checks).toBe('none');
  });
  it('maps state and review decision', () => {
    expect(mapPrJson('o/r', { ...base, state: 'MERGED', reviewDecision: 'APPROVED' })).toMatchObject({
      state: 'merged',
      review: 'approved',
    });
    expect(mapPrJson('o/r', { ...base, state: 'CLOSED', reviewDecision: '' })).toMatchObject({
      state: 'closed',
      review: 'none',
    });
    expect(mapPrJson('o/r', { ...base, reviewDecision: 'CHANGES_REQUESTED' }).review).toBe(
      'changes_requested',
    );
  });
});

describe('GithubConnector', () => {
  it('reports auth status', async () => {
    expect(await setup({ authed: false }).gh.status()).toBe('unauthenticated');
    fake.restore();
    expect(await setup().gh.status()).toBe('ok');
  });

  it('reads one PR and my open PRs', async () => {
    const { gh } = setup();
    fake.setPr(fakePr());
    fake.setPr(
      fakePr({ number: 8, url: 'https://github.com/example-org/temp-repo/pull/8', state: 'MERGED' }),
    );
    const one = await gh.prStatus({ repo: 'example-org/temp-repo', number: 7, url: '' });
    expect(one).toMatchObject({ state: 'open', review: 'review_required', headRef: 'feat/SAF-1-thing' });
    expect((await gh.myOpenPrs()).map((p) => p.pr.number)).toEqual([7]);
    expect(fake.calls().some((c) => c[0] === 'search' && c.includes('--author=@me'))).toBe(true);
  });

  it('emits pr.changed only on real changes, including PRs that left my open list', async () => {
    const { ctx, gh, changes } = setup();
    fake.setPr(fakePr());
    await gh.poll();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toBeNull();
    await gh.poll();
    expect(changes).toHaveLength(1);
    fake.setPr(
      fakePr({
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
        updatedAt: '2026-09-17T10:05:00Z',
      }),
    );
    await gh.poll();
    expect(changes[1]?.after.checks).toBe('failure');
    fake.setPr(fakePr({ state: 'MERGED', updatedAt: '2026-09-17T11:00:00Z' }));
    await gh.poll();
    expect(changes[2]).toMatchObject({ before: { state: 'open' }, after: { state: 'merged' } });
    expect(getPrStatus(ctx.db, 'example-org/temp-repo', 7)?.state).toBe('merged');
    await gh.poll();
    expect(changes).toHaveLength(3);
  });

  it('polls watched PRs that are not mine and skips when disabled', async () => {
    const { gh, changes } = setup();
    fake.setPr(
      fakePr({ number: 9, url: 'https://github.com/example-org/temp-repo/pull/9', state: 'CLOSED' }),
    );
    gh.watch({
      repo: 'example-org/temp-repo',
      number: 9,
      url: 'https://github.com/example-org/temp-repo/pull/9',
    });
    await gh.poll();
    expect(changes.map((c) => c.after.pr.number)).toEqual([9]);
    fake.restore();
    const off = setup({}, { enabled: false });
    fake.setPr(fakePr());
    await off.gh.poll();
    expect(off.changes).toEqual([]);
    expect(fake.calls()).toEqual([]);
  });

  it('emits review requests when they appear and disappear', async () => {
    const { ctx, gh } = setup();
    const seen: Array<[number, boolean]> = [];
    ctx.bus.on('pr.reviewRequested', (e) => seen.push([e.pr.number, e.active]));
    fake.setPr(
      fakePr({ number: 30, url: 'https://github.com/example-org/temp-repo/pull/30', reviewRequested: true }),
    );
    await gh.poll();
    await gh.poll();
    expect(seen).toEqual([[30, true]]);
    fake.setPr(
      fakePr({
        number: 30,
        url: 'https://github.com/example-org/temp-repo/pull/30',
        reviewRequested: true,
        state: 'MERGED',
      }),
    );
    await gh.poll();
    expect(seen).toEqual([
      [30, true],
      [30, false],
    ]);
  });

  it('keeps polling cached open PRs', async () => {
    const { ctx, gh, changes } = setup();
    upsertPrStatus(
      ctx.db,
      mapPrJson('example-org/temp-repo', {
        number: 7,
        url: 'https://github.com/example-org/temp-repo/pull/7',
        title: 't',
        state: 'OPEN',
        headRefName: 'feat/SAF-1-thing',
        updatedAt: '2026-09-17T09:00:00Z',
      }),
      '2026-09-17T09:00:00Z',
    );
    fake.setPr(fakePr({ state: 'MERGED' }));
    await gh.poll();
    expect(changes[0]?.after.state).toBe('merged');
  });

  describe('review-request rows across a daemon restart', () => {
    const reviewRow = (number: number) => ({
      kind: 'pr_event' as const,
      scope: { domain: 'pr', id: `example-org/temp-repo#${number}` },
      facet: 'review_requested',
      sessionId: null,
      projectId: null,
      ticket: null,
      reason: `Review requested: SAF-1 thing (example-org/temp-repo#${number})`,
      payload: { event: 'review_requested' },
    });

    /** A fresh connector (empty memory) over an inbox that already holds rows from before the restart. */
    function restarted(numbers: number[]) {
      const inbox = recordingInbox();
      const rows = numbers.map((n) => inbox.upsert(reviewRow(n)));
      const s = setup({}, {}, inbox);
      s.ctx.bus.on('pr.reviewRequested', (e) => prEventRule.handle(e, s.ctx));
      const stateOf = (id: string) => inbox.list({}).find((i) => i.id === id)?.state;
      return { ...s, inbox, rows, stateOf };
    }

    it('resolves a stale review-request row after a restart', async () => {
      const { gh, rows, stateOf } = restarted([41]);
      fake.setPr(
        fakePr({
          number: 41,
          url: 'https://github.com/example-org/temp-repo/pull/41',
          reviewRequested: true,
          state: 'MERGED',
        }),
      );
      await gh.poll();
      expect(fake.calls().some((c) => c[0] === 'search' && c.includes('--review-requested=@me'))).toBe(true);
      expect(stateOf(rows[0]?.id ?? '')).toBe('auto_resolved');
    });

    it('keeps a review-request row open while the PR is still in the search', async () => {
      const { gh, rows, stateOf } = restarted([42]);
      fake.setPr(
        fakePr({
          number: 42,
          url: 'https://github.com/example-org/temp-repo/pull/42',
          reviewRequested: true,
        }),
      );
      await gh.poll();
      expect(stateOf(rows[0]?.id ?? '')).toBe('open');
    });
  });
});
