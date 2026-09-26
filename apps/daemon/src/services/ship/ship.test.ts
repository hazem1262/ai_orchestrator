import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createShipService, type Launcher } from './ship.ts';

let repo: TempRepo | undefined;
let fake: FakeGh | undefined;
const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  repo?.cleanup();
  repo = undefined;
  fake?.restore();
  fake = undefined;
});

async function setup() {
  const r = makeTempRepo({ withRemote: true });
  repo = r;
  const f = useFakeGh({ repo: 'example-org/temp-repo' });
  fake = f;
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir }] }],
  });
  const audit = memoryAudit();
  const wtPath = join(r.dir, '.worktrees', 'feat-SAF-60-ship-it');
  const sessions = stubSessions([
    makeSession({
      id: 'ship',
      startCwd: wtPath,
      cwds: [wtPath],
      recap: 'Excluded weekends from the SLA deadline. Added tests.',
      name: 'SAF-60 ship it',
    }),
  ]);
  const ctx = createTestContext({
    config: () => cfg,
    audit,
    sessions,
    pty: recordingPty(),
    templates: stubTemplates(),
  });
  contexts.push(ctx);
  ctx.worktrees = createWorktreeService(ctx);
  ctx.github = createGithubConnector(ctx);
  const launched: Array<Parameters<Launcher>[0]> = [];
  const ship = createShipService(ctx, {
    launch: async (req) => {
      launched.push(req);
      return { ptyId: 'pty-bm', sessionId: null };
    },
  });
  const { view } = await ctx.worktrees.createWith(
    { repo: r.dir, base: 'main', type: 'feat', ticket: 'SAF-60', slug: 'ship it' },
    { runSetup: false, actor: 'user' },
  );
  const write = (rel: string, body: string) => r.write(join('.worktrees', 'feat-SAF-60-ship-it', rel), body);
  return { ctx, ship, audit, view, write, launched, repo: r, fake: f };
}

describe('ShipService.commit and push', () => {
  it('commits all changes, pushes the branch and audits both', async () => {
    const { ship, view, write, audit, repo } = await setup();
    write('src/a.ts', 'export const a = 60;\n');
    write('src/new.ts', 'export const n = 60;\n');
    const { sha } = await ship.commit(view.path, 'feat: SAF-60 ship it');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git('-C', view.path, 'log', '-1', '--format=%s').trim()).toBe('feat: SAF-60 ship it');
    expect(repo.git('-C', view.path, 'status', '--porcelain')).toBe('');
    await ship.push(view.path);
    const remote = execFileSync(
      'git',
      ['--git-dir', repo.remote ?? '', 'rev-parse', 'refs/heads/feat/SAF-60-ship-it'],
      { encoding: 'utf8' },
    ).trim();
    expect(remote).toBe(sha);
    expect(audit.entries.map((e) => [e.action, e.result])).toEqual([
      ['worktree.create', 'ok'],
      ['git.commit', 'ok'],
      ['git.push', 'ok'],
    ]);
  });

  it('refuses empty commits and protected branches', async () => {
    const { ship, view, repo } = await setup();
    await expect(ship.commit(view.path, 'nothing')).rejects.toMatchObject({
      code: 'nothing_to_commit',
    });
    repo.write('src/a.ts', 'on main\n');
    await expect(ship.commit(repo.dir, 'x')).rejects.toMatchObject({ code: 'protected_branch' });
    await expect(ship.push(repo.dir)).rejects.toMatchObject({ code: 'protected_branch' });
  });

  it('reports a rejected push instead of forcing it', async () => {
    const { ship, view, write, repo } = await setup();
    write('src/a.ts', 'one\n');
    await ship.commit(view.path, 'one');
    await ship.push(view.path);
    const other = join(repo.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', 'feat/SAF-60-ship-it', repo.remote ?? '', other]);
    execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'someone else'], {
      encoding: 'utf8',
    });
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'feat/SAF-60-ship-it']);
    write('src/a.ts', 'two\n');
    const mine = (await ship.commit(view.path, 'two')).sha;
    await expect(ship.push(view.path)).rejects.toMatchObject({ code: 'push_rejected' });
    const remote = execFileSync(
      'git',
      ['--git-dir', repo.remote ?? '', 'rev-parse', 'refs/heads/feat/SAF-60-ship-it'],
      { encoding: 'utf8' },
    ).trim();
    expect(remote).not.toBe(mine);
  });
});

describe('ShipService.suggest and createPr', () => {
  it('suggests message, title and body from the branch, recap and PR template', async () => {
    const { ship, view, write } = await setup();
    write('.github/pull_request_template.md', '## What\n\n## Testing\n');
    const s = await ship.suggest(view.path, 'claude:ship');
    expect(s).toMatchObject({ branch: 'feat/SAF-60-ship-it', base: 'main', ticket: 'SAF-60' });
    expect(s.message).toBe('feat: SAF-60 Excluded weekends from the SLA deadline');
    expect(s.title).toBe('SAF-60 Excluded weekends from the SLA deadline');
    expect(s.body).toContain('## What');
    expect(s.body).toContain('Excluded weekends from the SLA deadline. Added tests.');
    expect(s.body).toContain('Ticket: [SAF-60](https://linear.app/wakecap/issue/SAF-60)');
  });

  it('falls back to the branch slug without a recap or template', async () => {
    const { ship, view } = await setup();
    const s = await ship.suggest(view.path, null);
    expect(s.message).toBe('feat: SAF-60 ship it');
    expect(s.body.startsWith('## Summary')).toBe(true);
  });

  it('creates the PR with a body file, links it to the worktree and watches it', async () => {
    const { ctx, ship, view, write, audit, fake } = await setup();
    write('src/a.ts', 'pr\n');
    await ship.commit(view.path, 'feat: SAF-60 pr');
    await ship.push(view.path);
    const pr = await ship.createPr(view.path, {
      title: 'SAF-60 pr',
      body: 'Body with `code`',
      base: 'main',
    });
    expect(pr).toEqual({
      repo: 'example-org/temp-repo',
      number: 101,
      url: 'https://github.com/example-org/temp-repo/pull/101',
    });
    const created = fake.state().prs['example-org/temp-repo#101'];
    expect(created).toMatchObject({
      title: 'SAF-60 pr',
      body: 'Body with `code`',
      headRefName: 'feat/SAF-60-ship-it',
      baseRefName: 'main',
    });
    expect(getWorktree(ctx.db, view.path)?.prUrl).toBe(pr.url);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'pr.create', result: 'ok' });
    const call = fake.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(call).toContain('--body-file');
  });
});

describe('ShipService.merge and backmerge', () => {
  it('merges with the chosen method, never with --admin, and refreshes status', async () => {
    const { ctx, ship, audit, fake } = await setup();
    const changes: string[] = [];
    ctx.bus.on('pr.changed', (e) => changes.push(e.after.state));
    fake.setPr({
      repo: 'example-org/temp-repo',
      number: 5,
      url: 'https://github.com/example-org/temp-repo/pull/5',
      title: 't',
      state: 'OPEN',
      headRefName: 'feat/x',
      baseRefName: 'main',
      body: '',
      updatedAt: '2026-09-17T10:00:00Z',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [],
    });
    const pr = {
      repo: 'example-org/temp-repo',
      number: 5,
      url: 'https://github.com/example-org/temp-repo/pull/5',
    };
    ctx.github?.watch(pr);
    await ship.merge(pr, 'squash');
    const call = fake.calls().find((c) => c[0] === 'pr' && c[1] === 'merge');
    expect(call).toEqual(['pr', 'merge', '5', '--repo', 'example-org/temp-repo', '--squash']);
    expect(fake.state().prs['example-org/temp-repo#5']?.state).toBe('MERGED');
    expect(changes).toContain('merged');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'pr.merge', result: 'ok' });
  });

  it('launches the backmerge template in a session', async () => {
    const { ship, view, launched, audit } = await setup();
    await expect(ship.backmerge(view.path, 'wakecap', 'SAF-60')).resolves.toEqual({
      ptyId: 'pty-bm',
    });
    expect(launched[0]).toMatchObject({
      source: 'claude',
      projectId: 'wakecap',
      cwd: view.path,
      prompt: '/backmerge SAF-60',
      templateId: 'backmerge',
    });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'ship.backmerge', result: 'ok' });
  });
});
