import { expect, type Page, test } from '@playwright/test';

// A phone-width viewport (390×844) on the Chromium project. The Settings page must fit it: no
// sideways page scroll, and no panel content wider than the screen.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

interface Offender {
  panel: string;
  tag: string;
  text: string;
  left: number;
  right: number;
  width: number;
}

/**
 * Every element whose box sticks out past the viewport's right (or left) edge, attributed to the
 * nearest settings panel (`section`). An element inside a scroll or clip container that itself fits
 * the viewport is not counted: its overflow is contained. Only the outermost offender of each
 * subtree is reported, so the list names the element that causes the overflow, not its children.
 */
async function overflowingElements(page: Page): Promise<Offender[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const out = (r: DOMRect) => r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5);
    const root = document.querySelector('main') ?? document.body;
    // The page's own scroll region (`main`, overflow-auto) does not contain overflow: a panel wider
    // than it makes the page scroll sideways. Only a scroll or clip box inside a panel counts.
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible' && !out(p.getBoundingClientRect())) return true;
      }
      return false;
    };
    const panelOf = (el: Element): string => {
      const s = el.closest('section');
      if (!s) return '(page)';
      const label = s.getAttribute('aria-label');
      if (label) return label;
      const by = s.getAttribute('aria-labelledby');
      const h = (by && document.getElementById(by)) || s.querySelector('h2, h3');
      return h?.textContent?.trim() || '(unnamed section)';
    };
    const offending = new Set<Element>();
    for (const el of root.querySelectorAll('*')) {
      if (out(el.getBoundingClientRect()) && !clipped(el)) offending.add(el);
    }
    const res: Offender[] = [];
    for (const el of offending) {
      if (el.parentElement && offending.has(el.parentElement)) continue;
      const r = el.getBoundingClientRect();
      res.push({
        panel: panelOf(el),
        tag: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}` : ''}`,
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
      });
    }
    return res;
  });
}

/** Per section: the regions whose data must be on the page before its width is measured. */
const SECTIONS: Array<{ id: string; heading: string; wait: string[] }> = [
  { id: 'projects', heading: 'Projects', wait: ['Projects'] },
  { id: 'notifications', heading: 'Notifications', wait: ['Notifications'] },
  { id: 'recaps', heading: 'LLM recaps', wait: ['LLM recaps'] },
  { id: 'limits', heading: 'Limits & budgets', wait: ['Limits & budgets'] },
  { id: 'supervisor', heading: 'Supervisor (opt-in)', wait: [] },
  { id: 'connectors', heading: 'Connectors', wait: [] },
  { id: 'remote', heading: 'Remote & mobile', wait: [] },
  {
    id: 'advanced',
    heading: 'Transcript archive',
    wait: ['Transcript archive', 'Real-time bridge', 'Secrets hygiene'],
  },
];

for (const section of SECTIONS) {
  test(`settings section "${section.id}" fits a 390px phone screen with no sideways overflow`, async ({
    page,
  }) => {
    await page.goto(`/settings?section=${section.id}`);
    await expect(page.getByRole('heading', { level: 2, name: section.heading })).toBeVisible();
    // Wait for the panels that load data, so their lists and tables are on the page.
    for (const name of section.wait) {
      await expect(page.getByRole('region', { name })).toBeVisible();
    }
    if (section.id === 'advanced') await expect(page.getByTestId('secrets-summary')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const offenders = await overflowingElements(page);
    const byPanel = [...new Set(offenders.map((o) => o.panel))];
    console.log(`overflowing panels: ${JSON.stringify(byPanel)}`);
    for (const o of offenders) console.log(JSON.stringify(o));

    const widths = await page.evaluate(() => {
      const main = document.querySelector('main');
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        mainScrollWidth: main?.scrollWidth ?? 0,
        mainClientWidth: main?.clientWidth ?? 0,
      };
    });
    console.log(`widths: ${JSON.stringify(widths)}`);
    expect.soft(widths.scrollWidth, 'document scrolls sideways').toBeLessThanOrEqual(widths.innerWidth);
    expect.soft(widths.mainScrollWidth, 'main scrolls sideways').toBeLessThanOrEqual(widths.mainClientWidth);
    expect(offenders, 'elements wider than the viewport').toEqual([]);
  });
}

test('the phone section picker switches sections and writes ?section= to the URL', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
  // The desktop side list is hidden at phone width; the picker is the way in.
  await expect(page.getByRole('button', { name: 'Limits & budgets' })).toBeHidden();
  await page.getByRole('combobox', { name: 'Settings section' }).selectOption('limits');
  await expect(page).toHaveURL(/[?&]section=limits\b/);
  await expect(page.getByRole('heading', { level: 2, name: 'Limits & budgets' })).toBeVisible();
});
