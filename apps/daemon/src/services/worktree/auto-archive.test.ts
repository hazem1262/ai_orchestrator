import { existsSync } from 'node:fs';
import { OrcConfig } from '@orc/api-contract';
import type { AuditActor, PrStatus } from '@orc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, recordingInbox, stubSessions } from '../../../test/stubs.ts';
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
});
