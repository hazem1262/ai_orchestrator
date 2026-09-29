import { expect, type Page } from '@playwright/test';

/** Clicks `label` in the open confirm dialog (`dialog` or `alertdialog`) and waits for it to close. */
export async function confirmDialog(page: Page, label: string) {
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}
