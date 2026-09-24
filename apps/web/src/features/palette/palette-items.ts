import type { PlanRef } from '@orc/api-contract';
import type { PrRef, Source } from '@orc/core';

export type PaletteAction =
  | { type: 'navigate'; to: string; search?: Record<string, string> }
  | { type: 'openSession'; source: Source; id: string }
  | { type: 'resumeLast'; projectId: string }
  | { type: 'launch'; templateId?: string; projectId?: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openPlan'; path: string; title: string };

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  keywords: string[];
  shortcut?: string;
  action: PaletteAction;
}

export interface PaletteSection {
  heading: string;
  items: PaletteItem[];
}

export interface PaletteSession {
  source: Source;
  id: string;
  name: string | null;
  firstPrompt: string | null;
  projectId: string | null;
  tickets: string[];
  prs: PrRef[];
}

export interface PaletteInput {
  sessions: PaletteSession[];
  projects: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; label: string }>;
  plans: PlanRef[];
  currentProjectId: string | null;
}

const NAVIGATION: PaletteItem[] = [
  {
    id: 'nav:inbox',
    label: 'Open inbox',
    keywords: ['attention'],
    shortcut: 'g i',
    action: { type: 'navigate', to: '/inbox' },
  },
  {
    id: 'nav:waiting',
    label: 'Waiting sessions',
    keywords: ['live', 'input'],
    shortcut: 'g w',
    action: { type: 'navigate', to: '/live', search: { status: 'waiting' } },
  },
  {
    id: 'nav:history',
    label: 'History',
    keywords: ['search', 'sessions'],
    shortcut: 'g h',
    action: { type: 'navigate', to: '/history' },
  },
  { id: 'nav:live', label: 'Live board', keywords: ['running'], action: { type: 'navigate', to: '/live' } },
  {
    id: 'nav:audit',
    label: 'Audit log',
    keywords: ['actions'],
    shortcut: 'g a',
    action: { type: 'navigate', to: '/audit' },
  },
  {
    id: 'nav:settings',
    label: 'Settings',
    keywords: ['config', 'secrets'],
    action: { type: 'navigate', to: '/settings' },
  },
];

export function buildPaletteSections(input: PaletteInput): PaletteSection[] {
  const projects = [...input.projects].sort((a, b) =>
    a.id === input.currentProjectId ? -1 : b.id === input.currentProjectId ? 1 : a.name.localeCompare(b.name),
  );
  const actions: PaletteItem[] = [
    {
      id: 'act:new',
      label: 'New session',
      keywords: ['launch', 'start'],
      shortcut: 'n',
      action: { type: 'launch' },
    },
    ...projects.map((p) => ({
      id: `act:resume:${p.id}`,
      label: `Resume last session in ${p.name}`,
      keywords: ['resume', p.id],
      action: { type: 'resumeLast', projectId: p.id } as const,
    })),
    ...input.templates.map((t) => ({
      id: `act:launch:${t.id}`,
      label: `Launch: ${t.label}`,
      keywords: ['template', 'launch', t.id],
      action: {
        type: 'launch',
        templateId: t.id,
        ...(input.currentProjectId ? { projectId: input.currentProjectId } : {}),
      } as PaletteAction,
    })),
  ];

  const sessions: PaletteItem[] = input.sessions.map((s) => ({
    id: `session:${s.source}:${s.id}`,
    label: s.name ?? s.firstPrompt?.slice(0, 80) ?? s.id,
    hint: `${s.source}${s.projectId ? ` · ${s.projectId}` : ''}`,
    keywords: [s.id, ...s.tickets, ...s.prs.map((p) => `${p.repo}#${p.number}`)],
    action: { type: 'openSession', source: s.source, id: s.id },
  }));

  const tickets = [...new Set(input.sessions.flatMap((s) => s.tickets))].map<PaletteItem>((t) => ({
    id: `ticket:${t}`,
    label: t,
    hint: 'filter history',
    keywords: ['ticket'],
    action: { type: 'navigate', to: '/history', search: { ticket: t } },
  }));

  const prMap = new Map<string, PrRef>();
  for (const s of input.sessions) for (const p of s.prs) prMap.set(p.url, p);
  const prs = [...prMap.values()].map<PaletteItem>((p) => ({
    id: `pr:${p.url}`,
    label: `${p.repo}#${p.number}`,
    hint: 'open on GitHub',
    keywords: ['pr', 'pull request'],
    action: { type: 'openUrl', url: p.url },
  }));

  const plans = input.plans.map<PaletteItem>((p) => ({
    id: `plan:${p.path}`,
    label: p.title,
    hint: p.source,
    keywords: ['plan', ...p.tickets],
    action: { type: 'openPlan', path: p.path, title: p.title },
  }));

  return [
    { heading: 'Navigation', items: NAVIGATION },
    { heading: 'Actions', items: actions },
    { heading: 'Sessions', items: sessions },
    { heading: 'Tickets', items: tickets },
    { heading: 'Pull requests', items: prs },
    { heading: 'Plans', items: plans },
  ].filter((s) => s.items.length > 0);
}

export interface PaletteDeps {
  navigate(to: string, search?: Record<string, string>): void;
  openLaunch(prefill?: { templateId?: string; projectId?: string }): void;
  resumeLast(projectId: string): Promise<void>;
  openUrl(url: string): void;
  openPlan(path: string, title: string): void;
}

export async function runPaletteAction(a: PaletteAction, d: PaletteDeps): Promise<void> {
  switch (a.type) {
    case 'navigate':
      d.navigate(a.to, a.search);
      return;
    case 'openSession':
      d.navigate(`/sessions/${a.source}/${encodeURIComponent(a.id)}`, undefined);
      return;
    case 'launch': {
      const prefill: { templateId?: string; projectId?: string } = {};
      if (a.templateId) prefill.templateId = a.templateId;
      if (a.projectId) prefill.projectId = a.projectId;
      d.openLaunch(Object.keys(prefill).length ? prefill : undefined);
      return;
    }
    case 'resumeLast':
      await d.resumeLast(a.projectId);
      return;
    case 'openUrl':
      d.openUrl(a.url);
      return;
    case 'openPlan':
      d.openPlan(a.path, a.title);
      return;
  }
}
