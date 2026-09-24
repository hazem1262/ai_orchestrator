import type { SessionListItem, SessionListResponse } from '@orc/api-contract';
import type { InfiniteData } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useProjects } from '@/api/queries/projects.ts';
import { usePlanContent, usePlans } from '@/api/queries/safety.ts';
import { useSessions } from '@/api/queries/sessions.ts';
import { useTemplates } from '@/api/queries/templates.ts';
import { formatKeys } from '@/features/hotkeys/registry.ts';
import { useLaunchStore } from '@/stores/launch.ts';
import { usePaletteStore } from '@/stores/palette.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { buildPaletteSections, type PaletteAction, runPaletteAction } from './palette-items.ts';

/** The palette reads only the first page of the session search; a single page is accepted as-is. */
function firstPageItems(
  data: InfiniteData<SessionListResponse> | SessionListResponse | undefined,
): SessionListItem[] {
  if (!data) return [];
  return 'pages' in data ? (data.pages[0]?.items ?? []) : data.items;
}

export async function resumeLastInProject(projectId: string): Promise<void> {
  const api = getApiClient();
  const list = await api.sessionsList({ projectId, availability: 'resumable', limit: 1 });
  const s = list.items[0];
  if (!s) throw new Error('No resumable session in this project');
  const r = await api.sessionsResume(s.source, s.id, { mode: 'embedded' });
  if ('ptyId' in r) useTerminalStore.getState().open(r.ptyId, s.name ?? s.id);
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const projectId = useProjectStore((s) => s.projectId);
  const openLaunch = useLaunchStore((s) => s.show);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState<{ path: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  // Jumping searches every project; the project selector only scopes the actions list order.
  const sessions = useSessions({ q: trimmed || undefined, limit: 20 });
  const projects = useProjects();
  const templates = useTemplates(projectId ?? undefined);
  const plans = usePlans(trimmed);
  const planContent = usePlanContent(plan?.path ?? null);

  const sections = useMemo(
    () =>
      buildPaletteSections({
        sessions: firstPageItems(sessions.data),
        projects: projects.data ?? [],
        templates: templates.data ?? [],
        plans: plans.data ?? [],
        currentProjectId: projectId ?? null,
      }),
    [sessions.data, projects.data, templates.data, plans.data, projectId],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
    setPlan(null);
    setError(null);
  };

  const run = (a: PaletteAction) => {
    setError(null);
    runPaletteAction(a, {
      navigate: (to, search) => {
        close();
        void navigate({ to, search } as never);
      },
      openLaunch: (prefill) => {
        close();
        openLaunch(prefill);
      },
      resumeLast: async (pid) => {
        await resumeLastInProject(pid);
        close();
      },
      openUrl: (url) => {
        window.open(url, '_blank', 'noopener');
        close();
      },
      openPlan: (path, title) => setPlan({ path, title }),
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Action failed'));
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => (v ? setOpen(true) : close())}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/20"
      contentClassName="fixed left-1/2 top-24 z-50 w-[640px] max-w-[95vw] -translate-x-1/2 rounded-lg border border-neutral-200 bg-white shadow-xl"
    >
      {plan ? (
        <div className="p-3 text-sm">
          <button type="button" onClick={() => setPlan(null)} className="mb-2 underline">
            Back
          </button>
          <h2 className="mb-1 font-semibold">{plan.title}</h2>
          <pre data-testid="palette-plan" className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">
            {planContent.data?.text ?? 'Loading…'}
          </pre>
        </div>
      ) : (
        <>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Jump to a session, ticket, PR or plan, or run an action…"
            className="w-full border-b border-neutral-200 px-3 py-2 outline-none"
          />
          {error && (
            <p role="alert" className="px-3 py-1 text-xs text-red-600">
              {error}
            </p>
          )}
          <Command.List className="max-h-[60vh] overflow-auto p-1">
            <Command.Empty className="p-3 text-sm text-neutral-500">No results.</Command.Empty>
            {sections.map((section) => (
              <Command.Group
                key={section.heading}
                heading={section.heading}
                className="text-xs text-neutral-500"
              >
                {section.items.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.label} ${it.id}`}
                    keywords={it.keywords}
                    onSelect={() => run(it.action)}
                    className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm text-neutral-900 data-[selected=true]:bg-neutral-100"
                  >
                    <span>{it.label}</span>
                    <span className="ml-2 flex items-center gap-2 text-xs text-neutral-500">
                      {it.hint && <span>{it.hint}</span>}
                      {it.shortcut && <kbd>{formatKeys(it.shortcut)}</kbd>}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </>
      )}
    </Command.Dialog>
  );
}
