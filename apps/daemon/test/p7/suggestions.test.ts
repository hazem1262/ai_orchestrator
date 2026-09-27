import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinearConnector, LinearIssue } from '../../src/connectors/linear/linear.ts';
import { createSuggestionService, parseNewTodos } from '../../src/services/automations/suggestions.ts';
import { ServiceError } from '../../src/services/errors.ts';
import {
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeTemplates,
  fakeWorktrees,
  initGitRepo,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,0 +4,2 @@ export const a = 1;',
  '+// TODO: handle weekends',
  '+const x = 1;',
  '@@ -10 +12 @@',
  '-// TODO: old one',
  '+  /* FIXME(hazem) retry on 529 */',
  'diff --git a/README.md b/README.md',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+no markers here',
].join('\n');

describe('parseNewTodos', () => {
  it('finds added TODO/FIXME lines with their new line numbers', () => {
    expect(parseNewTodos(DIFF)).toEqual([
      { file: 'src/a.ts', line: 4, kind: 'TODO', text: 'handle weekends' },
      { file: 'src/a.ts', line: 12, kind: 'FIXME', text: 'retry on 529 */' },
    ]);
  });
});

const issue = (identifier: string, state: string): LinearIssue => ({
  id: identifier,
  identifier,
  title: `Title ${identifier}`,
  state,
  assignee: 'me',
  url: `https://linear.app/x/issue/${identifier}`,
  labels: [],
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

async function setup() {
  const cfg = testConfig({ automations: { suggestions: { enabled: true } } });
  const repo = await initGitRepo();
  await execa('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/SAF-3-x']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n// FIXME: flaky retry\n');
  await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'wip']);
  const worktrees = fakeWorktrees();
  const view = await worktrees.create({ repo, base: 'main', type: 'feat', ticket: 'SAF-3', slug: 'x' });
  view.path = repo;
  const linear = {
    status: async () => 'ok' as const,
    issue: async () => null,
    comment: async () => {},
    createIssue: async () => issue('SAF-0', 'Todo'),
    assignedToMe: async () => [issue('SAF-1', 'Todo'), issue('SAF-2', 'In Progress')],
    me: async () => ({ id: 'me', name: 'Me', email: 'me@example.com' }),
    invalidate: () => {},
  } as LinearConnector;
  const launcher = fakeLauncher();
  const audit = fakeAudit();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    worktrees,
    linear,
    launcher,
    audit,
    templates: fakeTemplates({ 'implement-ticket': '/conductor {{ticketUrl}}' }),
  });
  const svc = createSuggestionService({ ctx });
  return { svc, launcher, audit, repo };
}

describe('SuggestionService', () => {
  it('collects the Linear backlog and new FIXMEs once', async () => {
    const t = await setup();
    expect(await t.svc.refresh()).toEqual({ added: 2 });
    expect(await t.svc.refresh()).toEqual({ added: 0 });
    const list = t.svc.list('new');
    expect(list.map((s) => [s.source, s.title]).sort()).toEqual([
      ['linear', 'SAF-1: Title SAF-1'],
      ['todo', 'FIXME: flaky retry'],
    ]);
    const todo = list.find((s) => s.source === 'todo');
    expect(todo).toMatchObject({ ticket: 'SAF-3', line: 2, file: join(t.repo, 'a.ts') });
  });

  it('launches an owned session only when accepted, and only once', async () => {
    const t = await setup();
    await t.svc.refresh();
    const lin = t.svc.list('new').find((s) => s.source === 'linear');
    if (!lin) throw new Error('missing linear suggestion');
    expect(t.launcher.requests).toHaveLength(0);
    const res = await t.svc.accept(lin.id);
    expect(res).toEqual({ ptyId: 'pty-l1', sessionPk: 'claude:launched-1' });
    expect(t.launcher.requests[0]).toMatchObject({
      source: 'claude',
      projectId: 'wakecap',
      templateId: 'implement-ticket',
      ticket: 'SAF-1',
      vars: { ticket: 'SAF-1', ticketUrl: 'https://linear.app/x/issue/SAF-1' },
      planApproval: false,
    });
    expect(t.svc.list().find((s) => s.id === lin.id)).toMatchObject({
      state: 'accepted',
      runPtyId: 'pty-l1',
    });
    expect(t.audit.entries.find((e) => e.action === 'session.launch')).toMatchObject({
      actor: 'user',
      params: { suggestionId: lin.id },
    });
    await expect(t.svc.accept(lin.id)).rejects.toBeInstanceOf(ServiceError);
  });

  it('launches TODO fixes in the worktree and dismisses others', async () => {
    const t = await setup();
    await t.svc.refresh();
    const todo = t.svc.list('new').find((s) => s.source === 'todo');
    const lin = t.svc.list('new').find((s) => s.source === 'linear');
    if (!todo || !lin) throw new Error('missing suggestions');
    await t.svc.accept(todo.id);
    expect(t.launcher.requests[0]).toMatchObject({ cwd: t.repo, ticket: 'SAF-3' });
    expect(t.launcher.requests[0]?.prompt).toContain('FIXME: flaky retry');
    expect(t.svc.dismiss(lin.id).state).toBe('dismissed');
    expect(t.svc.list('new')).toEqual([]);
  });
});
