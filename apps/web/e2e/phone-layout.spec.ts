import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

// A phone-width viewport (390×844) on the Chromium project. Each list screen must fit it: the
// document does not scroll sideways, and neither does the page's own scroll region (`main`).
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// A git repository inside the fixture project's directory, with one worktree created through the
// API: it gives /worktrees a row and /audit a `worktree.create` entry, both carrying real paths.
const WORK = process.env.ORC_E2E_WORK ?? '';
const REPO = join(WORK, 'phone-layout-repo');

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  });
}

test.beforeAll(async ({ browser }) => {
  if (!WORK) throw new Error('ORC_E2E_WORK is not set; run this spec through playwright.config.ts');
  if (existsSync(REPO)) return;
  mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-b', 'main');
  writeFileSync(join(REPO, 'README.md'), 'phone layout fixture\n');
  writeFileSync(join(REPO, '.gitignore'), '.worktrees/\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'initial');

  const page = await browser.newPage();
  await page.goto('/inbox');
  const token = await page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__);
  const res = await page.request.post('/api/worktrees', {
    headers: { 'x-orc-token': token },
    data: {
      repo: REPO,
      base: 'main',
      type: 'feat',
      ticket: null,
      slug: 'phone-width-layout-check',
      runSetup: false,
      confirm: true,
    },
  });
  expect(res.ok(), `create worktree: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.close();
});

interface Widths {
  docScrollWidth: number;
  innerWidth: number;
  mainScrollWidth: number;
  mainClientWidth: number;
}

async function widthsOf(page: Page): Promise<Widths> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mainScrollWidth: main?.scrollWidth ?? 0,
      mainClientWidth: main?.clientWidth ?? 0,
    };
  });
}

test('history rows show the session title at phone width', async ({ page }) => {
  await page.goto('/history');
  const title = page.getByRole('link', { name: 'Notification service test check' });
  await expect(title).toBeAttached();
  const box = await title.boundingBox();
  expect(box?.width ?? 0, 'history session title width (px)').toBeGreaterThan(80);
  await expect(title).toBeVisible();
});

// Each screen is loaded until its seeded content (or its empty state) is on the page, so the
// measurement is of the rendered list, not of a loading placeholder.
const SCREENS: { path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    path: '/live',
    ready: async (page) => {
      await page.waitForLoadState('networkidle');
    },
  },
  {
    path: '/streams',
    ready: async (page) => {
      await expect(page.getByText('SAF-1787').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    path: '/worktrees',
    ready: async (page) => {
      await expect(page.getByText('phone-width-layout-check').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    path: '/audit',
    ready: async (page) => {
      await expect(page.getByText('worktree.create').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    path: '/history',
    ready: async (page) => {
      await expect(page.getByRole('link', { name: 'Notification service test check' })).toBeAttached();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    path: '/sessions/claude/s-subagents',
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1, name: 'investigate SUPRT-1557' })).toBeVisible();
      await page.waitForLoadState('networkidle');
    },
  },
];

for (const screen of SCREENS) {
  test(`${screen.path} fits a 390px phone screen with no sideways scroll`, async ({ page }) => {
    await page.goto(screen.path);
    await screen.ready(page);
    const w = await widthsOf(page);
    console.log(`${screen.path} widths: ${JSON.stringify(w)}`);
    expect.soft(w.docScrollWidth, `${screen.path}: document scrollWidth`).toBeLessThanOrEqual(390);
    expect(w.mainScrollWidth, `${screen.path}: main scrollWidth vs clientWidth + 1`).toBeLessThanOrEqual(
      w.mainClientWidth + 1,
    );
  });
}
