import { expect, type Page, test } from '@playwright/test';

// baseURL and the fixture daemon come from apps/web/playwright.config.ts (A14).
async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__);
}

async function expandIfCollapsed(page: Page, labels: string[]) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: `Expand ${label}` });
    if ((await button.count()) > 0) await button.click();
  }
}

test.describe('M3 exit: a subagent session is understandable without the terminal', () => {
  test.describe.configure({ mode: 'serial' });

  test('timeline, stats, agents, usage, files, links, raw and export', async ({ page }) => {
    await page.goto('/sessions/claude/s-subagents');
    await expect(page.getByRole('heading', { level: 1, name: 'investigate SUPRT-1557' })).toBeVisible();
    await expect(page.getByTestId('session-stats')).toContainText('model');
    await expect(page.getByRole('button', { name: 'Agent ×1' })).toBeVisible();

    await page.getByRole('radio', { name: 'Verbose' }).check({ force: true });
    await expect(page.getByRole('button', { name: 'Agent: Explore logs' })).toBeVisible();
    await page.getByRole('button', { name: 'Agent: Explore logs' }).click();
    await expect(page.getByRole('complementary', { name: 'Step inspector' })).toContainText(
      '"subagent_type": "Explore"',
    );
    await page.getByRole('radio', { name: 'Normal' }).check({ force: true });

    await page.getByRole('tab', { name: /Agents/ }).click();
    await expect(page.getByTestId('agent-node-ag1')).toBeVisible();
    await expect(page.getByTestId('agent-node-ag1')).toContainText('background');
    await expandIfCollapsed(page, ['Explore logs', 'Deep dive']);
    await page.getByRole('button', { name: 'Open Leaf' }).click();
    await expect(page).toHaveURL(/tab=timeline/);
    await expect(page).toHaveURL(/agent=ag3/);
    await expect(page.getByText('Subagent: Leaf')).toBeVisible();
    await expect(page.getByText('done', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to main session' }).click();

    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.getByTestId('usage-chart').locator('canvas')).toBeVisible();

    await page.getByRole('tab', { name: 'Files' }).click();
    await expect(page.getByText('No files were edited by tools in this session.')).toBeVisible();

    await page.getByRole('tab', { name: 'Links' }).click();
    await expect(page.getByRole('region', { name: 'Tickets' })).toContainText('SUPRT-1557');

    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect(page.getByText('"sessionId":"s-subagents"').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Transcript' }).selectOption('ag1');
    await expect(page.getByText('"agentId":"ag1"').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export ZIP' }).click();
    expect((await download).suggestedFilename()).toBe('claude-s-subagents.zip');
  });

  test('palette jumps to the session and every app action is in the audit log', async ({ page, request }) => {
    await page.goto('/history');
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox').fill('SUPRT-1557');
    await page.getByRole('option', { name: /investigate SUPRT-1557/ }).click();
    await expect(page).toHaveURL(/\/sessions\/claude\/s-subagents/);

    const auth = { 'x-orc-token': await tokenOf(page) };
    const resumed = await request.post('/api/sessions/claude/s-subagents/resume', {
      headers: auth,
      data: { mode: 'embedded' },
    });
    expect(resumed.ok()).toBeTruthy();
    const { ptyId } = (await resumed.json()) as { ptyId: string };
    const killed = await request.delete(`/api/pty/${ptyId}`, { headers: auth, data: { confirm: true } });
    expect(killed.ok()).toBeTruthy();

    await page.goto('/audit?sessionPk=claude%3As-subagents');
    await expect(page.getByRole('cell', { name: 'session.resume' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'session.kill' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'session.export' })).toBeVisible();

    await page.locator('body').click();
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/inbox/);
  });
});
