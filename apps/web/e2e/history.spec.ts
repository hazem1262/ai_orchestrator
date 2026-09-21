import { expect, test } from '@playwright/test';

test('finds sessions by keyword, shows prompts-only history and opens the detail view', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/history/);
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('wakecap');
  await expect(page.getByRole('link', { name: 'Notification service test check' })).toBeVisible();

  const oldRow = page.locator('tr', { hasText: 'old session from december' });
  await expect(oldRow.getByText('prompts-only')).toBeVisible();
  await expect(oldRow.getByRole('button', { name: 'Resume' })).toBeDisabled();

  const search = page.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('weekends');
  await expect(page.getByRole('link', { name: 'SAF-1787 SLA weekends' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Notification service test check' })).toHaveCount(0);
  await expect(page).toHaveURL(/q=weekends/);

  await search.fill('');
  await page.getByRole('link', { name: 'Notification service test check' }).click();
  await expect(page).toHaveURL(/\/sessions\/claude\/s-basic$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Notification service test check' }),
  ).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText('check the notification service tests')).toBeVisible();
  await expect(timeline.getByText('Bash ×1')).toBeVisible();
  await expect(timeline.getByText('Recap: Ran tests (18 passed) and edited a.ts.')).toBeVisible();
});

test('resumes into an embedded terminal in the original cwd and replays after reload', async ({ page }) => {
  await page.goto('/history?q=e2e');
  await page.getByRole('link', { name: 'e2e resumable session' }).click();
  await page.getByRole('button', { name: 'Resume' }).click();

  const terminal = page.locator('.xterm-rows');
  await expect(terminal).toContainText('fake-claude --dangerously-skip-permissions --resume e2e-resume');
  await expect(terminal).toContainText('/work/Wakecap/e2e');
  // xterm.js layers an interactive `.xterm-screen` selection/cursor element directly over
  // `.xterm-rows`, which Playwright's actionability check treats as an interceptor even though
  // it is exactly what a real user's click lands on and focuses; force the click through it.
  await terminal.click({ force: true });
  await page.keyboard.type('hello-e2e');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('hello-e2e');

  await page.reload();
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e');

  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(page.getByRole('region', { name: 'Terminals' })).toHaveCount(0);
});

test('the API refuses requests without the token', async ({ request }) => {
  expect((await request.get('/api/sessions')).status()).toBe(401);
  expect((await request.get('/api/pty')).status()).toBe(401);
});
