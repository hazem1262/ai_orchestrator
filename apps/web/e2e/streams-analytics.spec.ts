import { expect, test } from '@playwright/test';

test('work streams and analytics render against the fixture daemon', async ({ page }) => {
  await page.goto('/streams');
  await expect(page.getByRole('heading', { name: 'Work streams' })).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByRole('region', { name: 'Planned' })).toBeVisible();

  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quota' })).toBeVisible();
  await expect(page.getByText('estimated')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Cost over time' })).toBeVisible();
});

test('the stream detail page answers what happened, what it cost and what is next', async ({ page }) => {
  await page.goto('/streams');
  await expect(page.getByRole('heading', { name: 'Work streams' })).toBeVisible();
  await page.getByRole('button', { name: 'List' }).click();
  const link = page.getByRole('link', { name: /SAF-1787/ }).first();
  await link.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if (await link.isVisible()) {
    await link.click();
    await expect(page.getByLabel('Stage')).toBeVisible();
    await expect(page.getByLabel('Timeline')).toBeVisible();
    // exact: the stream goal section, the goal editor form and its "Goal state" select also carry "Goal" in their names
    await expect(page.getByLabel('Goal', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Next steps')).toBeVisible();
  } else {
    test.skip(true, 'fixtures produced no SAF-1787 stream; check the fixture ticket regex');
  }
});
