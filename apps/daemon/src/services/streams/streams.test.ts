import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamPr } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { toStreamPr } from '../pr-source.ts';
import type { WorktreeService } from '../worktree/worktree.ts';
import { createStreamService } from './streams.ts';

let root: string;
let wstack: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orc-streams-'));
  wstack = join(root, 'wstack');
  mkdirSync(join(root, 'ws', 'plans', 'sla'), { recursive: true });
  writeFileSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md'), '# plan');
  const planTime = new Date('2026-09-01T00:00:00.000Z');
  utimesSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md'), planTime, planTime);
  writeFileSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787.key'), 'never read');
  mkdirSync(join(wstack, 'workflows'), { recursive: true });
  writeFileSync(
    join(wstack, 'workflows', 'wf-1.env'),
    'WORKFLOW_ID=wf-1\nBRANCH=fix/SAF-2000-bug\nREPO_SLUG=svc\n',
  );
  vi.stubEnv('WSTACK_HOME', wstack);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const PR = (n: number, p: Partial<StreamPr>): StreamPr => ({
  pr: {
    repo: 'example-org/wakecap-wecare-service',
    number: n,
    url: `https://github.com/example-org/wakecap-wecare-service/pull/${n}`,
  },
  title: `PR ${n}`,
  state: 'open',
  headRef: null,
  baseRef: null,
  isBackmerge: false,
  checks: 'success',
  review: 'approved',
  updatedAt: '2026-09-02T12:00:00.000Z',
  mergedAt: null,
  ...p,
});

function setup() {
  const prs = [
    PR(231, {
      title: 'feat(sla): SAF-1787 exclude weekends',
      headRef: 'feat/SAF-1787-exclude-weekends',
      state: 'merged',
      mergedAt: '2026-09-03T09:00:00.000Z',
    }),
    PR(240, {
      title: 'backmerge master → staging',
      headRef: 'backmerge/SAF-1787-staging',
      isBackmerge: true,
      state: 'merged',
      mergedAt: '2026-09-04T12:00:00.000Z',
    }),
  ];
  const sessions = [
    makeSession({
      id: 's-prlink',
      tickets: ['SAF-1787'],
      name: 'SAF-1787 SLA weekends',
      prs: [prs[0]?.pr ?? PR(0, {}).pr],
      skills: ['conductor'],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 3 },
      recap: 'Excluded weekends.\n**Goal:** …',
    }),
    makeSession({
      id: 's-review',
      firstPrompt: '/review SAF-1787 please',
      skills: ['review'],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 },
      lastActivityAt: '2026-09-04T10:00:00.000Z',
    }),
    makeSession({ id: 's-other', firstPrompt: 'unrelated work' }),
    makeSession({ id: 's-forza', projectId: 'forza', tickets: ['SAF-9999'] }),
  ];
  const t = makeP5Context({
    config: withWakecap(join(root, 'ws')),
    data: { sessions },
    overrides: {},
  });
  t.ctx.worktrees = {
    discover: async () => [
      {
        path: join(root, 'ws', 'svc', '.worktrees', 'feat-SAF-3000'),
        repo: 'svc',
        branch: 'feat/SAF-3000-new',
        base: 'master',
        ticket: 'SAF-3000',
        dirty: false,
        prUrl: null,
        state: 'active',
        createdByApp: true,
        head: null,
        isMain: false,
        origin: 'app',
        sessionPks: [],
        projectId: 'wakecap',
        prStatus: null,
        updatedAt: '2026-09-05T00:00:00.000Z',
      },
    ],
  } as unknown as WorktreeService;
  const checks: unknown[] = [];
  const svc = createStreamService(t.ctx, {
    prs: { list: () => prs },
    meter: {
      checkBudget: (s) => {
        checks.push(s);
        return { ok: true, pct: 0.1, limitUsd: 50 };
      },
    },
    now: () => new Date('2026-09-17T10:00:00.000Z'),
  });
  return { ...t, svc, checks };
}

describe('stream service', () => {
  it('builds streams for workStreams projects from every source', async () => {
    const { svc } = setup();
    const streams = await svc.refresh();
    expect(streams.map((s) => [s.ticket, s.stage])).toEqual([
      ['SAF-1787', 'backmerged'],
      ['SAF-2000', 'planned'],
      ['SAF-3000', 'implementing'],
    ]);
    const saf = streams[0];
    expect(saf).toMatchObject({
      projectId: 'wakecap',
      title: 'feat(sla): SAF-1787 exclude weekends',
      sessionIds: ['claude:s-review', 'claude:s-prlink'], // listAllSessions returns newest activity first
      costUsd: 4.5,
      lastActivityAt: '2026-09-04T10:00:00.000Z',
    });
    expect(saf?.plans).toEqual([join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md')]);
    expect(saf?.prs.map((p) => p.number)).toEqual([231, 240]);
    expect(svc.list({ stage: 'implementing' }).map((s) => s.ticket)).toEqual(['SAF-3000']);
  });

  it('returns a detail view with timeline, budget and links', async () => {
    const { svc, checks } = setup();
    const d = await svc.get('SAF-1787');
    expect(d?.budget).toEqual({ ok: true, pct: 0.1, limitUsd: 50 });
    expect(checks).toContainEqual({ ticket: 'SAF-1787', projectId: 'wakecap' });
    // newest first: PR 240 merged 09-04, PR 231 merged 09-03, recap 09-01T10, both sessions start 09-01T09, plan mtime 09-01T00
    expect(d?.timeline.map((i) => i.kind)).toEqual(['pr', 'pr', 'recap', 'session', 'session', 'plan']);
    expect(d?.timeline.find((i) => i.kind === 'recap')?.detail).toContain('Excluded weekends.');
    expect(d?.links.filter((l) => l.kind === 'session').map((l) => l.origin)).toEqual(['auto', 'auto']);
    expect(await svc.get('SAF-424242')).toBeNull();
  });

  it('honours manual unlink and link across refreshes', async () => {
    const { svc } = setup();
    await svc.refresh();
    svc.unlink('SAF-1787', 'session', 'claude:s-review');
    svc.link('SAF-1787', 'session', 'claude:s-other');
    const saf = (await svc.refresh()).find((s) => s.ticket === 'SAF-1787');
    expect(saf?.sessionIds).toEqual(['claude:s-prlink', 'claude:s-other']);
    const links = (await svc.get('SAF-1787'))?.links ?? [];
    expect(links.find((l) => l.ref === 'claude:s-review')).toMatchObject({
      origin: 'manual',
      excluded: true,
    });
  });

  it('skips projects without workStreams', async () => {
    const { svc, ctx } = setup();
    ctx.updateConfig?.((c) => ({
      ...c,
      projects: c.projects.map((p) => ({ ...p, features: { ...p.features, workStreams: false } })),
    }));
    expect(await svc.refresh()).toEqual([]);
  });

  it('maps P4 PrStatus to StreamPr', () => {
    expect(
      toStreamPr({
        pr: { repo: 'o/r', number: 1, url: 'u' },
        state: 'merged',
        title: 'Backmerge master',
        checks: 'none',
        review: 'none',
        updatedAt: 't',
        headRef: 'x',
        failedChecks: [],
      }),
    ).toEqual({
      pr: { repo: 'o/r', number: 1, url: 'u' },
      title: 'Backmerge master',
      state: 'merged',
      headRef: 'x',
      baseRef: null,
      isBackmerge: true,
      checks: 'none',
      review: 'none',
      updatedAt: 't',
      mergedAt: 't',
    });
  });
});
