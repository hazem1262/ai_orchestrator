import { devices, expect, type Page, test } from '@playwright/test';

// iPhone 14 viewport, touch and user agent on the Chromium project; `defaultBrowserType` would force
// WebKit, which this suite does not install.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 14'];
test.use(iPhone);

async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__);
}

test('phone layout shows the inbox, the bottom nav and a reply composer', async ({ page, request }) => {
  await page.goto('/inbox');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav).toBeVisible();
  await expect(nav.getByText('Live')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  // Resuming the seeded `e2e-resume` transcript in an app PTY makes it an owned session. The fake
  // `claude` then goes idle, which files a "ready for review" inbox item.
  const auth = { 'x-orc-token': await tokenOf(page) };
  const resumed = await request.post('/api/sessions/claude/e2e-resume/resume', {
    headers: auth,
    data: { mode: 'embedded' },
  });
  expect(resumed.ok()).toBeTruthy();
  const { ptyId } = (await resumed.json()) as { ptyId: string };

  try {
    const card = page.getByRole('article', { name: /fake session: ready for review/ }).first();
    await expect(card).toBeVisible({ timeout: 8000 });
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Snooze 1h' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Done' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      /\/sessions\/claude\//,
    );
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(card).toBeHidden();

    await page.goto('/sessions/claude/e2e-resume');
    await expect(page.getByRole('heading', { level: 1, name: 'e2e resumable session' })).toBeVisible();
    await expect(page.getByLabel('Reply to this session')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await page.getByLabel('Reply to this session').fill('yes, continue');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  } finally {
    // Leave no live session behind for the specs that run after this one.
    await request.delete(`/api/pty/${ptyId}`, { headers: auth, data: { confirm: true } });
  }
});
