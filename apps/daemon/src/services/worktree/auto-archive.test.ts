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
});
