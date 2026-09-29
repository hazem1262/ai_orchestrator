import { expect, test } from '@playwright/test';

test('a ?section= deep link opens that section, and the side nav switches it', async ({ page }) => {
  await page.goto('/settings?section=remote');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Remote & mobile' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button', { name: 'Remote & mobile' })).toHaveAttribute('aria-current', 'page');
  // The phone picker is hidden on a desktop screen.
  await expect(page.getByRole('combobox', { name: 'Settings section' })).toBeHidden();

  await nav.getByRole('button', { name: 'Notifications' }).click();
  await expect(page).toHaveURL(/[?&]section=notifications\b/);
  await expect(page.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Remote & mobile' })).toHaveCount(0);
});

test('an unknown ?section= falls back to Projects', async ({ page }) => {
  await page.goto('/settings?section=nope');
  await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});
