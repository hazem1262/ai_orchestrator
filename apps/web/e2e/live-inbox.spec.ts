import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The e2e daemon roots its temp homes at $TMPDIR/orc-e2e and puts the launchable work directory at
// orc-e2e/work/Wakecap, which is the Wakecap project's first pathPrefix and so the launch dialog's
// default cwd. ORC_E2E_WORK overrides it when the daemon is started by hand somewhere else.
const WORK = process.env.ORC_E2E_WORK ?? join(realpathSync(tmpdir()), 'orc-e2e', 'work', 'Wakecap');

test.describe.configure({ mode: 'serial' });

function inboxItems(page: import('@playwright/test').Page) {
  return page.getByRole('list', { name: 'Inbox items' }).getByRole('listitem');
}

async function launch(page: import('@playwright/test').Page, prompt: string) {
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await expect(dialog.getByLabel('Working directory')).toHaveAttribute('placeholder', WORK);
  await dialog.getByLabel('Prompt').fill(prompt);
  await dialog.getByRole('button', { name: 'Launch' }).click();
  await expect(dialog).toBeHidden();
}

test('root redirects to the inbox', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
});

test('a waiting session shows on the board and in the inbox within seconds', async ({ page }) => {
  await page.goto('/inbox');
  await launch(page, 'please wait for me');
  const item = inboxItems(page).filter({ hasText: 'fake session: waiting — input needed' });
  await expect(item).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveTitle('(1) Orchestrator');
  await expect(page.getByRole('link', { name: 'Inbox, 1 open' })).toBeVisible();

  await page.getByRole('link', { name: 'Live' }).click();
  const card = page.getByRole('article', { name: 'fake session — Waiting' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-attention', 'true');
  await expect(card.getByRole('button', { name: 'Terminal' })).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('article', { name: 'fake session — Ended' })).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole('link', { name: /Inbox,/ }).click();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible({ timeout: 5000 });
});

test('review and red tests are triaged with the keyboard', async ({ page }) => {
  await page.goto('/inbox');
  await launch(page, 'fix it and fail');
  await expect(inboxItems(page)).toHaveCount(2, { timeout: 8000 });
  await expect(inboxItems(page).filter({ hasText: 'Tests red' })).toBeVisible();
  await expect(inboxItems(page).filter({ hasText: 'Ready for review' })).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('e');
  await expect(inboxItems(page)).toHaveCount(1);
  await page.keyboard.press('s');
  await expect(inboxItems(page)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Snoozed' }).click();
  await expect(inboxItems(page)).toHaveCount(1);
});

test('settings show archive status and retention warning', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^\d+ files · /)).toBeVisible();
  await expect(page.getByRole('status')).toContainText('30 days (default)');
  await expect(page.getByText('"cleanupPeriodDays": 3650')).toBeVisible();
});
