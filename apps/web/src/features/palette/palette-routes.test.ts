import { describe, expect, it } from 'vitest';
import { buildPaletteSections } from './palette-items.ts';

// Every top-level section of the app, the same set the desktop sidebar (`nav[aria-label=Main]`)
// links to. The palette is the phone's way to reach them, so it must offer each one.
const TOP_LEVEL_ROUTES = [
  '/inbox',
  '/live',
  '/worktrees',
  '/history',
  '/settings',
  '/audit',
  '/streams',
  '/analytics',
  '/automations',
];

describe('palette navigation', () => {
  it('offers a navigate item for every top-level route', () => {
    const sections = buildPaletteSections({
      sessions: [],
      projects: [],
      templates: [],
      plans: [],
      currentProjectId: null,
    });
    const targets = new Set(
      sections.flatMap((s) => s.items).flatMap((i) => (i.action.type === 'navigate' ? [i.action.to] : [])),
    );
    const missing = TOP_LEVEL_ROUTES.filter((r) => !targets.has(r));
    expect(missing, 'top-level routes with no palette item').toEqual([]);
  });
});
