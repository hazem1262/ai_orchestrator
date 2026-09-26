import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type M4State, STATE_FILE } from './support/m4-seed';

const state = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as M4State;
const BRANCH = 'feat/SAF-4242-e2e-flow';

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:4418${path}`, { headers: { 'x-orc-token': state().token } });
  return (await r.json()) as T;
}

async function confirmDialog(page: import('@playwright/test').Page, label: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('ticket → worktree → agent → review with inline comment → PR → merged → worktree archived', async ({
  page,
}) => {
  const s = state();
  const wtPath = join(s.repo, '.worktrees', 'feat-SAF-4242-e2e-flow');

  // 1. ticket → worktree + agent
  await page.goto('/worktrees');
  await expect(page.getByRole('cell', { name: 'main', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New worktree' }).click();
  await page.getByLabel('Ticket').fill('SAF-4242');
  await page.getByLabel('Short description').fill('e2e flow');
  await expect(page.getByLabel('Branch preview')).toHaveText(BRANCH);
  await page.getByLabel('Launch Claude in the new worktree').check();
  await page.getByLabel('Prompt').fill('implement SAF-4242');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await confirmDialog(page, 'Create');
  await expect(page.getByText(BRANCH)).toBeVisible();

  // 2. the (fake) agent edits a file
  await expect
    .poll(
      () =>
        existsSync(join(wtPath, 'src/a.ts')) &&
        readFileSync(join(wtPath, 'src/a.ts'), 'utf8').includes('agent edit'),
    )
    .toBe(true);
  await expect
    .poll(async () => (await api<{ owned: boolean }>('/api/review/claude/e2e-session-1')).owned, {
      timeout: 30_000,
    })
    .toBe(true);

  // 3. review with an inline comment sent to the agent
  await page.goto('/review/claude/e2e-session-1');
  await expect(page.getByRole('navigation', { name: 'Changed files' }).getByText('src/a.ts')).toBeVisible();
  await page.getByRole('navigation', { name: 'Changed files' }).getByLabel('Viewed src/a.ts').check();
  const addedLine = page.locator('tr', { hasText: 'agentEdit' }).first();
  await addedLine.hover();
  await addedLine.locator('.diff-add-widget').first().click();
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('name this constant AGENT_EDIT');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('src/a.ts:2')).toBeVisible();
  await page.getByRole('button', { name: 'Send to agent' }).click();
  await confirmDialog(page, 'Send');
  await expect
    .poll(() => {
      const log = join(s.dir, 'agent-input.log');
      return existsSync(log) ? readFileSync(log, 'utf8') : '';
    })
    .toContain('src/a.ts:2');

  // 4. commit → push → PR
  await expect(page.getByLabel('Commit message')).toHaveValue(/SAF-4242/);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await confirmDialog(page, 'Commit');
  await page.getByRole('button', { name: 'Push', exact: true }).click();
  await confirmDialog(page, 'Push');
  await page.getByRole('button', { name: 'Create PR', exact: true }).click();
  await confirmDialog(page, 'Create PR');
  await expect(page.getByRole('link', { name: /#101/ })).toBeVisible();

  // 5. merge → auto-archive
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await confirmDialog(page, 'Merge');
  await expect.poll(() => existsSync(wtPath), { timeout: 30_000 }).toBe(false);
  const active = await api<Array<{ branch: string }>>('/api/worktrees?state=active');
  expect(active.map((w) => w.branch)).not.toContain(BRANCH);

  // 6. every write is audited, archive by automation (soft: one run reports every missing entry)
  const audit = await api<Array<{ action: string; actor: string; result: string }>>('/api/audit?limit=200');
  const actions = audit.filter((e) => e.result === 'ok').map((e) => e.action);
  for (const a of [
    'worktree.create',
    'session.launch',
    'review.send',
    'git.commit',
    'git.push',
    'pr.create',
    'pr.merge',
    'worktree.archive',
  ]) {
    expect.soft(actions).toContain(a);
  }
  expect.soft(audit.find((e) => e.action === 'worktree.archive')?.actor).toBe('automation');
  const ghCalls = readFileSync(join(s.ghDir, 'calls.jsonl'), 'utf8');
  expect.soft(ghCalls).not.toContain('--admin');
  expect.soft(ghCalls).not.toContain('--force');
});
