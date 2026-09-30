import { existsSync } from 'node:fs';
import { OrcConfig } from '@orc/api-contract';
import type { AuditActor, PrStatus } from '@orc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import type { WorktreeRow } from '../../db/repos/worktrees.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { registerAutoArchive } from './auto-archive.ts';
import { createWorktreeService } from './worktree.ts';

let repo: TempRepo | undefined;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
  repo = undefined;
});

const merged = (url: string, headRef: string, beforeState: PrStatus['state'] = 'open') => {
  const base: PrStatus = {
    pr: { repo: 'o/r', number: 1, url },
    state: beforeState,
    title: 't',
    checks: 'success',
    review: 'approved',
    updatedAt: '2026-09-17T10:00:00Z',
    headRef,
    failedChecks: [],
  };
  return {
    type: 'pr.changed' as const,
    before: base,
    after: { ...base, state: 'merged' as const, updatedAt: '2026-09-17T11:00:00Z' },
  };
};

async function setup(autoArchiveOnMerge = true) {
  const r = makeTempRepo();
  repo = r;
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir }] }],
    worktrees: { autoArchiveOnMerge },
  });
  const audit = memoryAudit();
  const inbox = recordingInbox();
  const ctx = createTestContext({
    config: () => cfg,
    audit,
    inbox,
    pty: recordingPty(),
    sessions: stubSessions([]),
  });
  disposers.push(() => ctx.dispose());
  const service = createWorktreeService(ctx);
  const archiveCalls: Array<[string, AuditActor]> = [];
  ctx.worktrees = {
    ...service,
    archiveAs: (path, actor, o) => {
      archiveCalls.push([path, actor]);
      return service.archiveAs(path, actor, o);
    },
  };
  const { view } = await ctx.worktrees.createWith(
    { repo: r.dir, base: 'main', type: 'feat', ticket: 'SAF-50', slug: 'merge me' },
    { runSetup: false, actor: 'user' },
  );
  const url = 'https://github.com/o/r/pull/1';
  const row = getWorktree(ctx.db, view.path);
  if (!row) throw new Error('no row');
  upsertWorktree(ctx.db, { ...row, prUrl: url });
  const off = registerAutoArchive(ctx);
  disposers.push(off);
  return { ctx, view, url, audit, inbox, off, archiveCalls, row: { ...row, prUrl: url } };
}

describe('registerAutoArchive', () => {
  it('archives an app worktree when its PR merges, as the automation actor', async () => {
    const { ctx, view, url, audit, off } = await setup();
    ctx.bus.emit(merged(url, view.branch));
    await vi.waitFor(() => {
      expect(existsSync(view.path)).toBe(false);
      expect(audit.entries.find((e) => e.action === 'worktree.archive')).toBeDefined();
    });
    expect(audit.entries.find((e) => e.action === 'worktree.archive')).toMatchObject({
      actor: 'automation',
      result: 'ok',
    });
    off();
  });

  it('leaves dirty and external worktrees in place and raises an inbox item', async () => {
    const { ctx, view, url, inbox, row, off } = await setup();
    repo?.write('.worktrees/feat-SAF-50-merge-me/src/a.ts', 'dirty\n');
    ctx.bus.emit(merged(url, view.branch));
    await vi.waitFor(() => expect(inbox.upserts.length).toBeGreaterThan(0));
    expect(existsSync(view.path)).toBe(true);
    expect(inbox.upserts.at(-1)).toMatchObject({
      kind: 'pr_event',
      scope: { domain: 'worktree', id: view.path },
      facet: 'archive_blocked',
    });
    expect(inbox.upserts.at(-1)?.reason).toContain('uncommitted changes');

    const before = inbox.upserts.length;
    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    ctx.bus.emit(merged(url, view.branch));
    await vi.waitFor(() => expect(inbox.upserts.length).toBeGreaterThan(before));
    expect(existsSync(view.path)).toBe(true);
    expect(inbox.upserts.at(-1)?.reason).toContain('not created by the app');
    off();
  });

  it('respects the setting and ignores non-transitions', async () => {
    const { ctx, view, url, archiveCalls, off } = await setup(false);
    ctx.bus.emit(merged(url, view.branch));
    expect(archiveCalls).toEqual([]);
    expect(existsSync(view.path)).toBe(true);
    off();
    const again = await (async () => {
      repo?.cleanup();
      return setup(true);
    })();
    again.ctx.bus.emit(merged(again.url, again.view.branch, 'merged'));
    expect(again.archiveCalls).toEqual([]);
    expect(existsSync(again.view.path)).toBe(true);
    again.off();
  });

  describe('cross-repo PR links', () => {
    const OTHER = 'https://github.com/o/other/pull/1';
    const mergedOther = (headRef: string) => {
      const e = merged(OTHER, headRef);
      const pr = { repo: 'o/other', number: 1, url: OTHER };
      return { ...e, before: { ...e.before, pr }, after: { ...e.after, pr } };
    };

    it('ignores a merged PR from another repo even when the worktree row links it', async () => {
      const { ctx, view, row, inbox, archiveCalls, off } = await setup();
      repo?.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
      upsertWorktree(ctx.db, { ...row, prUrl: OTHER, createdByApp: false, origin: 'worktree-dir' });
      ctx.bus.emit(mergedOther(view.branch));
      await new Promise((r) => setTimeout(r, 200));
      expect(archiveCalls).toEqual([]);
      expect(inbox.upserts).toEqual([]);
      off();
    });

    it('resolves archive_blocked rows whose PR is from another repo at startup', async () => {
      const { ctx, view, inbox, off } = await setup();
      off();
      repo?.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
      const row = (prRepo: string) =>
        inbox.upsert({
          kind: 'pr_event',
          scope: { domain: 'worktree', id: view.path },
          facet: `archive_blocked`,
          reason: `${prRepo}#1 merged; worktree kept because it was not created by the app`,
          payload: {
            pr: { repo: prRepo, number: 1, url: `https://github.com/${prRepo}/pull/1` },
            event: 'archive_blocked',
            path: view.path,
            presetId: null,
            vars: {},
          },
        });
      const stateOf = (id: string) => inbox.list({}).find((i) => i.id === id)?.state;

      const same = row('o/r');
      disposers.push(registerAutoArchive(ctx));
      await new Promise((r) => setTimeout(r, 200));
      expect(stateOf(same.id)).toBe('open');

      const wrong = row('o/other');
      disposers.push(registerAutoArchive(ctx));
      await vi.waitFor(() => expect(stateOf(wrong.id)).toBe('auto_resolved'));
    });
  });

  describe('closing the archive_blocked row', () => {
    const DIRTY = '.worktrees/feat-SAF-50-merge-me/src/a.ts';
    const ORIGINAL = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

    async function blockedByDirt() {
      const s = await setup();
      repo?.write(DIRTY, 'dirty\n');
      s.ctx.bus.emit(merged(s.url, s.view.branch));
      await vi.waitFor(() => expect(s.inbox.upserts.length).toBeGreaterThan(0));
      const row = s.inbox.list({ state: ['open'] }).find((i) => i.payload.event === 'archive_blocked');
      if (!row) throw new Error('no archive_blocked row');
      const stateOf = () => s.inbox.list({}).find((i) => i.id === row.id)?.state;
      return { ...s, stateOf };
    }

    it('resolves the archive_blocked row when the worktree is removed', async () => {
      const { ctx, view, stateOf, off } = await blockedByDirt();
      ctx.bus.emit({ type: 'worktree.removed', path: `${view.path}-other` });
      expect(stateOf()).toBe('open');
      ctx.bus.emit({ type: 'worktree.removed', path: view.path });
      expect(stateOf()).toBe('auto_resolved');
      off();
    });

    it('resolves the archive_blocked row when the worktree is archived', async () => {
      const { ctx, view, stateOf, off } = await blockedByDirt();
      const removed: string[] = [];
      ctx.bus.on('worktree.removed', (e) => removed.push(e.path));
      repo?.write(DIRTY, ORIGINAL);
      await ctx.worktrees?.archiveAs(view.path, 'user');
      expect(existsSync(view.path)).toBe(false);
      expect(removed).toEqual([view.path]);
      expect(stateOf()).toBe('auto_resolved');
      off();
    });

    it('resolves archive_blocked rows left for worktrees that are no longer active at startup', async () => {
      const { ctx, view, inbox, off } = await setup();
      off();
      const row = (path: string) =>
        inbox.upsert({
          kind: 'pr_event',
          scope: { domain: 'worktree', id: path },
          facet: 'archive_blocked',
          reason: 'o/r#1 merged; worktree kept because it has uncommitted changes',
          payload: { event: 'archive_blocked', path, presetId: null, vars: {} },
        });
      const stale = row(`${view.path}-gone`);
      const snoozed = inbox.snooze(row(`${view.path}-archived`).id, '2099-01-01T00:00:00Z');
      const live = row(view.path);
      const stateOf = (id: string) => inbox.list({}).find((i) => i.id === id)?.state;

      disposers.push(registerAutoArchive(ctx));

      expect(stateOf(stale.id)).toBe('auto_resolved');
      expect(stateOf(snoozed.id)).toBe('auto_resolved');
      expect(stateOf(live.id)).toBe('open');
    });
  });
  describe('external worktrees are grouped per repo', () => {
    const mergedPr = (repoSlug: string, number: number, headRef: string) => {
      const url = `https://github.com/${repoSlug}/pull/${number}`;
      const e = merged(url, headRef);
      const pr = { repo: repoSlug, number, url };
      return { ...e, before: { ...e.before, pr }, after: { ...e.after, pr } };
    };
    const external = (
      ctx: Parameters<typeof upsertWorktree>[0],
      base: WorktreeRow,
      repoDir: string,
      n: number,
    ) => {
      const w: WorktreeRow = {
        ...base,
        path: `${repoDir}/.worktrees/ext-${n}`,
        repo: repoDir,
        branch: `ext-${n}`,
        prUrl: `https://github.com/o/r/pull/${n}`,
        createdByApp: false,
        origin: 'worktree-dir',
        sessionPks: [],
      };
      upsertWorktree(ctx, w);
      return w;
    };
    const grouped = (inbox: ReturnType<typeof recordingInbox>, repoDir: string) =>
      inbox
        .list({ state: ['open', 'snoozed'] })
        .filter((i) => i.payload.event === 'archive_external' && i.payload.repo === repoDir);
    const entries = (item: { payload: Record<string, unknown> } | undefined) =>
      (item?.payload.worktrees ?? []) as Array<{ path: string; pr: { number: number } }>;

    it('raises one row per repo listing every external worktree, and a per-worktree row for a dirty one', async () => {
      const { ctx, view, url, inbox, row, off } = await setup();
      const dir = repo?.dir ?? '';
      const other = makeTempRepo();
      disposers.push(() => other.cleanup());
      const a = external(ctx.db, row, dir, 2);
      const b = external(ctx.db, row, dir, 3);
      const c = external(ctx.db, row, other.dir, 4);
      ctx.bus.emit(mergedPr('o/r', 2, a.branch));
      ctx.bus.emit(mergedPr('o/r', 3, b.branch));
      ctx.bus.emit(mergedPr('o/r', 4, c.branch));
      repo?.write('.worktrees/feat-SAF-50-merge-me/src/a.ts', 'dirty\n');
      ctx.bus.emit(merged(url, view.branch));

      await vi.waitFor(() => {
        expect(entries(grouped(inbox, dir)[0])).toHaveLength(2);
        expect(entries(grouped(inbox, other.dir)[0])).toHaveLength(1);
        expect(inbox.list({ state: ['open'] }).some((i) => i.payload.path === view.path)).toBe(true);
      });
      const rows = grouped(inbox, dir);
      expect(rows).toHaveLength(1);
      expect(inbox.upserts.find((u) => u.payload?.event === 'archive_external')).toMatchObject({
        kind: 'pr_event',
        facet: 'archive_external',
      });
      expect(entries(rows[0]).map((e) => [e.path, e.pr.number])).toEqual([
        [a.path, 2],
        [b.path, 3],
      ]);
      expect(rows[0]?.reason).toContain('2 merged worktrees in o/r were not created by the app');
      expect(
        inbox.list({ state: ['open'] }).filter((i) => i.payload.event === 'archive_blocked'),
      ).toHaveLength(1);
      expect(
        inbox.list({ state: ['open'] }).find((i) => i.payload.event === 'archive_blocked')?.reason,
      ).toContain('uncommitted changes');

      ctx.bus.emit(mergedPr('o/r', 2, a.branch));
      await new Promise((r) => setTimeout(r, 100));
      expect(entries(grouped(inbox, dir)[0])).toHaveLength(2);
      off();
    });

    it('drops a removed worktree from the grouped row and resolves the row with the last one', async () => {
      const { ctx, inbox, row, off } = await setup();
      const dir = repo?.dir ?? '';
      const a = external(ctx.db, row, dir, 2);
      const b = external(ctx.db, row, dir, 3);
      ctx.bus.emit(mergedPr('o/r', 2, a.branch));
      ctx.bus.emit(mergedPr('o/r', 3, b.branch));
      await vi.waitFor(() => expect(entries(grouped(inbox, dir)[0])).toHaveLength(2));
      const id = grouped(inbox, dir)[0]?.id;

      ctx.bus.emit({ type: 'worktree.removed', path: a.path });
      expect(entries(grouped(inbox, dir)[0]).map((e) => e.path)).toEqual([b.path]);
      expect(grouped(inbox, dir)[0]?.reason).toContain('1 merged worktree in o/r was not created by the app');

      ctx.bus.emit({ type: 'worktree.removed', path: b.path });
      expect(grouped(inbox, dir)).toEqual([]);
      expect(inbox.list({}).find((i) => i.id === id)?.state).toBe('auto_resolved');
      off();
    });

    it('folds per-worktree "not created by the app" rows into the grouped row at startup', async () => {
      const { ctx, view, inbox, row, off } = await setup();
      off();
      const dir = repo?.dir ?? '';
      const a = external(ctx.db, row, dir, 2);
      const b = external(ctx.db, row, dir, 3);
      const legacy = (path: string, n: number, why: string) =>
        inbox.upsert({
          kind: 'pr_event',
          scope: { domain: 'worktree', id: path },
          facet: 'archive_blocked',
          reason: `o/r#${n} merged; worktree kept because ${why}`,
          payload: {
            pr: { repo: 'o/r', number: n, url: `https://github.com/o/r/pull/${n}` },
            event: 'archive_blocked',
            path,
            presetId: null,
            vars: {},
          },
        });
      const la = legacy(a.path, 2, 'it was not created by the app (archive it yourself)');
      const lb = legacy(b.path, 3, 'it was not created by the app (archive it yourself)');
      const dirty = legacy(view.path, 1, 'it has uncommitted changes');
      const stateOf = (id: string) => inbox.list({}).find((i) => i.id === id)?.state;

      disposers.push(registerAutoArchive(ctx));

      await vi.waitFor(() => expect(entries(grouped(inbox, dir)[0])).toHaveLength(2));
      expect(stateOf(la.id)).toBe('auto_resolved');
      expect(stateOf(lb.id)).toBe('auto_resolved');
      expect(stateOf(dirty.id)).toBe('open');
      expect(grouped(inbox, dir)).toHaveLength(1);
      expect(entries(grouped(inbox, dir)[0]).map((e) => [e.path, e.pr.number])).toEqual([
        [a.path, 2],
        [b.path, 3],
      ]);
    });
  });

  describe('worktrees linked to a PR already merged in pr_cache', () => {
    const cacheMerged = (ctx: Parameters<typeof upsertPrStatus>[0], n: number, headRef: string) =>
      upsertPrStatus(
        ctx,
        {
          ...merged(`https://github.com/o/r/pull/${n}`, headRef).after,
          pr: { repo: 'o/r', number: n, url: `https://github.com/o/r/pull/${n}` },
        },
        '2026-09-17T11:00:00Z',
      );
    const grouped = (inbox: ReturnType<typeof recordingInbox>) =>
      inbox.list({ state: ['open', 'snoozed'] }).filter((i) => i.payload.event === 'archive_external');
    const listed = (inbox: ReturnType<typeof recordingInbox>) =>
      grouped(inbox).flatMap(
        (i) => (i.payload.worktrees ?? []) as Array<{ path: string; pr: { number: number } }>,
      );

    it('lists an external worktree in its repo row when discovery links it to a merged PR', async () => {
      const { ctx, inbox, off } = await setup();
      const dir = repo?.dir ?? '';
      repo?.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
      cacheMerged(ctx.db, 7, 'ext-7');
      const path = `${dir}/.worktrees/ext-7`;
      repo?.git('worktree', 'add', '-b', 'ext-7', path, 'main');

      await ctx.worktrees?.discover();

      expect(getWorktree(ctx.db, path)?.prUrl).toBe('https://github.com/o/r/pull/7');
      await vi.waitFor(() => expect(listed(inbox).map((e) => [e.path, e.pr.number])).toEqual([[path, 7]]));
      await ctx.worktrees?.discover();
      await new Promise((r) => setTimeout(r, 100));
      expect(listed(inbox).filter((e) => e.path === path)).toHaveLength(1);
      off();
    });

    it('archives an app worktree when discovery links it to a merged PR', async () => {
      const { ctx, view, row, audit, off } = await setup();
      off();
      repo?.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
      upsertWorktree(ctx.db, { ...row, prUrl: 'https://github.com/o/other/pull/9' });
      disposers.push(registerAutoArchive(ctx));
      cacheMerged(ctx.db, 1, view.branch);

      await ctx.worktrees?.discover();

      expect(getWorktree(ctx.db, view.path)?.prUrl).toBe('https://github.com/o/r/pull/1');
      await vi.waitFor(() => {
        expect(existsSync(view.path)).toBe(false);
        expect(audit.entries.find((e) => e.action === 'worktree.archive')).toMatchObject({
          actor: 'automation',
          result: 'ok',
        });
      });
    });

    it('lists active external worktrees linked to a merged PR but missing from their repo row at startup', async () => {
      const { ctx, row, inbox, off } = await setup();
      off();
      const dir = repo?.dir ?? '';
      const ext = (n: number) => {
        const w: WorktreeRow = {
          ...row,
          path: `${dir}/.worktrees/ext-${n}`,
          branch: `ext-${n}`,
          prUrl: `https://github.com/o/r/pull/${n}`,
          createdByApp: false,
          origin: 'worktree-dir',
          sessionPks: [],
        };
        upsertWorktree(ctx.db, w);
        cacheMerged(ctx.db, n, w.branch);
        return w;
      };
      const a = ext(2);
      const b = ext(3);
      const c = ext(4);
      const open = merged(c.prUrl ?? '', c.branch).before;
      upsertPrStatus(
        ctx.db,
        { ...open, pr: { repo: 'o/r', number: 4, url: c.prUrl ?? '' } },
        '2026-09-17T11:00:00Z',
      );
      inbox.upsert({
        kind: 'pr_event',
        scope: { domain: 'repo', id: dir },
        facet: 'archive_external',
        reason: '1 merged worktree in o/r was not created by the app — archive it yourself',
        payload: {
          event: 'archive_external',
          repo: dir,
          label: 'o/r',
          worktrees: [{ path: a.path, pr: { repo: 'o/r', number: 2, url: a.prUrl } }],
          presetId: null,
          vars: {},
        },
      });

      disposers.push(registerAutoArchive(ctx));

      await vi.waitFor(() =>
        expect(listed(inbox).map((e) => [e.path, e.pr.number])).toEqual([
          [a.path, 2],
          [b.path, 3],
        ]),
      );
      expect(grouped(inbox)).toHaveLength(1);
    });
  });
});
