import type { PlanRef } from '@orc/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { buildPaletteSections, type PaletteInput, runPaletteAction } from './palette-items.ts';

const plan: PlanRef = {
  path: '/p/SAF-1787.md',
  title: 'SLA plan',
  source: 'wakecap-plans',
  mtime: '',
  reason: 'query',
  tickets: ['SAF-1787'],
};

const input: PaletteInput = {
  sessions: [
    {
      source: 'claude',
      id: 's-prlink',
      name: 'SAF-1787 SLA weekends',
      firstPrompt: null,
      projectId: 'wakecap',
      tickets: ['SAF-1787'],
      prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
    },
    {
      source: 'claude',
      id: 's-basic',
      name: null,
      firstPrompt: 'check the notification service tests',
      projectId: 'wakecap',
      tickets: ['SAF-1787'],
      prs: [],
    },
  ],
  projects: [
    { id: 'stocks', name: 'Stocks' },
    { id: 'wakecap', name: 'Wakecap' },
  ],
  templates: [{ id: 'implement', label: 'Implement ticket' }],
  plans: [plan],
  currentProjectId: 'wakecap',
};

describe('buildPaletteSections', () => {
  it('builds navigation, actions and jump targets', () => {
    const sections = buildPaletteSections(input);
    expect(sections.map((s) => s.heading)).toEqual([
      'Navigation',
      'Actions',
      'Sessions',
      'Tickets',
      'Pull requests',
      'Plans',
    ]);
    const nav = sections[0]?.items.map((i) => [i.label, i.shortcut]);
    expect(nav).toEqual([
      ['Open inbox', 'g i'],
      ['Waiting sessions', 'g w'],
      ['History', 'g h'],
      ['Live board', undefined],
      ['Audit log', 'g a'],
      ['Settings', undefined],
    ]);
    expect(sections[1]?.items.map((i) => i.label)).toEqual([
      'New session',
      'Resume last session in Wakecap',
      'Resume last session in Stocks',
      'Launch: Implement ticket',
    ]);
    expect(sections[2]?.items.map((i) => [i.label, i.keywords])).toEqual([
      ['SAF-1787 SLA weekends', ['s-prlink', 'SAF-1787', 'example-org/svc#231']],
      ['check the notification service tests', ['s-basic', 'SAF-1787']],
    ]);
    expect(sections[3]?.items).toEqual([
      {
        id: 'ticket:SAF-1787',
        label: 'SAF-1787',
        hint: 'filter history',
        keywords: ['ticket'],
        action: { type: 'navigate', to: '/history', search: { ticket: 'SAF-1787' } },
      },
    ]);
    expect(sections[4]?.items[0]?.action).toEqual({
      type: 'openUrl',
      url: 'https://github.com/example-org/svc/pull/231',
    });
    expect(sections[5]?.items[0]?.action).toEqual({
      type: 'openPlan',
      path: '/p/SAF-1787.md',
      title: 'SLA plan',
    });
  });

  it('drops empty sections', () => {
    const sections = buildPaletteSections({ ...input, sessions: [], plans: [] });
    expect(sections.map((s) => s.heading)).toEqual(['Navigation', 'Actions']);
  });
});

describe('runPaletteAction', () => {
  it('dispatches each action type', async () => {
    const d = {
      navigate: vi.fn(),
      openLaunch: vi.fn(),
      resumeLast: vi.fn(async () => undefined),
      openUrl: vi.fn(),
      openPlan: vi.fn(),
    };
    await runPaletteAction({ type: 'openSession', source: 'claude', id: 's 1' }, d);
    expect(d.navigate).toHaveBeenLastCalledWith('/sessions/claude/s%201', undefined);
    await runPaletteAction({ type: 'navigate', to: '/live', search: { status: 'waiting' } }, d);
    expect(d.navigate).toHaveBeenLastCalledWith('/live', { status: 'waiting' });
    await runPaletteAction({ type: 'launch', templateId: 'implement', projectId: 'wakecap' }, d);
    expect(d.openLaunch).toHaveBeenCalledWith({ templateId: 'implement', projectId: 'wakecap' });
    await runPaletteAction({ type: 'resumeLast', projectId: 'wakecap' }, d);
    expect(d.resumeLast).toHaveBeenCalledWith('wakecap');
    await runPaletteAction({ type: 'openUrl', url: 'https://x' }, d);
    expect(d.openUrl).toHaveBeenCalledWith('https://x');
    await runPaletteAction({ type: 'openPlan', path: '/p', title: 'T' }, d);
    expect(d.openPlan).toHaveBeenCalledWith('/p', 'T');
  });
});
