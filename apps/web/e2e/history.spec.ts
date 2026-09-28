import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

interface InboxItem {
  id: string;
  kind: string;
  reason: string;
}

async function authOf(page: Page): Promise<Record<string, string>> {
  return {
    'x-orc-token': await page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__),
  };
}

async function openInbox(request: APIRequestContext, auth: Record<string, string>): Promise<InboxItem[]> {
  const res = await request.get('/api/inbox?state=open,snoozed', { headers: auth });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as InboxItem[];
}

test('finds sessions by keyword, shows prompts-only history and opens the detail view', async ({ page }) => {
  await page.goto('/history');
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
  await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  const turn = page.getByRole('region', { name: 'Turn 1' });
  await expect(turn.getByRole('heading', { name: 'check the notification service tests' })).toBeVisible();
  await expect(turn.getByRole('button', { name: 'Bash ×1' })).toBeVisible();
  await expect(
    page.getByTestId('timeline-scroll').getByText('Recap: Ran tests (18 passed) and edited a.ts.'),
  ).toBeVisible();
});

test('resumes into an embedded terminal in the original cwd and replays after reload', async ({
  page,
  request,
}) => {
  await page.goto('/history?q=e2e');
  const auth = await authOf(page);
  // The resumed fake reports under its own session id, so the items this test files are the ones
  // that were not open before it started.
  const before = new Set((await openInbox(request, auth)).map((i) => i.id));
  const filedHere = async () => (await openInbox(request, auth)).filter((i) => !before.has(i.id));
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

  // The resumed fake goes idle about a second after it starts, which files a "ready for review"
  // inbox item that stays open after Stop by design. Wait for it before stopping, so no status
  // change is still in flight, then close it: the specs that run next count inbox items from zero.
  await expect
    .poll(async () => (await filedHere()).map((i) => i.kind), { timeout: 10_000 })
    .toContain('review');

  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(page.getByRole('region', { name: 'Terminals' })).toHaveCount(0);

  await expect(async () => {
    for (const item of await filedHere()) {
      expect(
        (await request.post(`/api/inbox/${item.id}/done`, { headers: auth, data: {} })).ok(),
      ).toBeTruthy();
    }
    expect(await filedHere()).toEqual([]);
  }).toPass({ timeout: 10_000 });
});

test('the API refuses requests without the token', async ({ request }) => {
  expect((await request.get('/api/sessions')).status()).toBe(401);
  expect((await request.get('/api/pty')).status()).toBe(401);
});

// Every spec shares one fixture daemon, and live-inbox.spec.ts runs next and counts open inbox
// items from zero (`(1) Orchestrator`). This file must leave the inbox as it found it.
test('leaves no open inbox items behind for the specs that run after it', async ({ page, request }) => {
  await page.goto('/history');
  const auth = {
    'x-orc-token': await page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__),
  };
  // The resumed fake `claude` goes idle about one second after it starts; give its status change
  // time to reach the inbox before reading it.
  await page.waitForTimeout(3000);
  const res = await request.get('/api/inbox?state=open,snoozed', { headers: auth });
  expect(res.ok()).toBeTruthy();
  const items = (await res.json()) as { kind: string; reason: string; sessionId: string | null }[];
  expect(items.map((i) => `${i.kind}: ${i.reason}`)).toEqual([]);
});
