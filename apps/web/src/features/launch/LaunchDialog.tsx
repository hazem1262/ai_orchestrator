import {
  ApiRequestError,
  type CompareVariantInput,
  type LaunchRequestInput,
  type TemplateDto,
} from '@orc/api-contract';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { scopeProject } from '@/api/queries/inbox.ts';
import { useLaunch } from '@/api/queries/launch.ts';
import { useProjects } from '@/api/queries/projects.ts';
import { useTemplates } from '@/api/queries/templates.ts';
import { useWorktrees } from '@/api/queries/worktrees.ts';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useFocusReturn } from '@/components/ui/use-focus-return.ts';
import { CompareLaunchSection } from '@/features/compare/CompareLaunchSection.tsx';
import { type LaunchDraft, LaunchPhase4Fields } from '@/features/launch/LaunchPhase4Fields.tsx';
import { useLaunchStore } from '@/stores/launch.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';

const VAR_LABEL: Record<TemplateDto['vars'][number], string> = {
  ticket: 'Ticket',
  ticketUrl: 'Ticket URL',
  prUrl: 'PR URL',
  file: 'File',
  check: 'Failing check',
};

export function describeLaunchError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const d = (err.details ?? {}) as { missing?: string[]; max?: number; running?: number };
    switch (err.code) {
      case 'concurrency_limit':
        return `Concurrency limit reached: ${d.running ?? '?'}/${d.max ?? '?'} app-owned sessions in this project.`;
      case 'template_var_missing':
        return `Missing template fields: ${(d.missing ?? []).join(', ')}`;
      case 'not_implemented':
        return `Not available yet: ${err.message}`;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function LaunchDialog() {
  const open = useLaunchStore((s) => s.open);
  const preset = useLaunchStore((s) => s.preset);
  const hide = useLaunchStore((s) => s.hide);
  const returnFocus = useFocusReturn(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={returnFocus}
        aria-describedby={undefined}
        className="top-4 max-h-[calc(100%-2rem)] translate-y-0 overflow-auto sm:top-8 sm:max-h-[calc(100%-4rem)] sm:max-w-xl"
      >
        {/* The content unmounts on close, so each open starts from a fresh form. */}
        <LaunchForm preset={preset} onClose={hide} />
      </DialogContent>
    </Dialog>
  );
}

const FIELD = 'flex flex-col gap-1 text-sm';

function LaunchForm({
  preset,
  onClose,
}: {
  preset: Partial<LaunchRequestInput> | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const globalProject = scopeProject(useProjectStore((s) => s.projectId));
  const projects = useProjects().data ?? [];
  const [source, setSource] = useState<'claude' | 'codex'>(preset?.source ?? 'claude');
  const [projectId, setProjectId] = useState(preset?.projectId ?? globalProject ?? '');
  const [cwd, setCwd] = useState(preset?.cwd ?? '');
  const [templateId, setTemplateId] = useState(preset?.templateId ?? '');
  const [vars, setVars] = useState<Record<string, string>>(preset?.vars ?? {});
  const [ticket, setTicket] = useState(preset?.ticket ?? '');
  const [model, setModel] = useState(preset?.model ?? '');
  const [prompt, setPrompt] = useState(preset?.prompt ?? '');
  const [planApproval, setPlanApproval] = useState(preset?.planApproval ?? false);
  const [worktree, setWorktree] = useState<LaunchDraft['worktree']>(preset?.worktree);
  const [compare, setCompare] = useState<CompareVariantInput[]>(preset?.compare ?? []);
  const navigate = useNavigate();
  const worktrees = useWorktrees({ state: 'active' });
  const templates = useTemplates(projectId || undefined).data ?? [];
  const launch = useLaunch();
  const openTerminal = useTerminalStore((t) => t.open);

  const defaultCwd = projects.find((p) => p.id === projectId)?.pathPrefixes[0] ?? '';
  const template = templates.find((t) => t.id === templateId);
  const draft: LaunchDraft = {
    source,
    projectId: projectId || null,
    cwd: cwd || defaultCwd,
    prompt,
    ...(ticket ? { ticket } : {}),
    planApproval,
    ...(worktree ? { worktree } : {}),
  };
  const onDraftChange = (d: LaunchDraft) => {
    setPlanApproval(d.planApproval ?? false);
    setWorktree(d.worktree);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const req: LaunchRequestInput = {
      source,
      projectId: projectId || null,
      cwd: cwd || defaultCwd,
      prompt,
      ...(templateId ? { templateId } : {}),
      vars,
      ...(ticket ? { ticket } : {}),
      ...(model ? { model } : {}),
      ...(source === 'claude' && planApproval ? { planApproval: true } : {}),
      ...(worktree ? { worktree } : {}),
      ...(compare.length >= 2 ? { compare } : {}),
    };
    try {
      const res = await launch.mutateAsync(req);
      if ('compareGroupId' in res) {
        onClose();
        void navigate({ to: '/compare/$groupId', params: { groupId: res.compareGroupId } });
        return;
      }
      if ('ptyId' in res) openTerminal(res.ptyId, template?.label ?? (prompt.slice(0, 40) || 'New session'));
      onClose();
    } catch {
      // The failure is rendered from `launch.error`, and the dialog stays open.
    }
  };

  return (
    <>
      <DialogTitle className="text-lg font-semibold">New session</DialogTitle>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <fieldset className="flex gap-3 text-sm">
          <legend className="sr-only">Source</legend>
          {(['claude', 'codex'] as const).map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input
                type="radio"
                name="source"
                className="accent-primary"
                checked={source === s}
                onChange={() => setSource(s)}
              />
              {s === 'claude' ? 'Claude' : 'Codex'}
            </label>
          ))}
        </fieldset>

        <label className={FIELD} htmlFor={`${titleId}-project`}>
          Project
        </label>
        <NativeSelect
          id={`${titleId}-project`}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">(none)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>

        <label className={FIELD} htmlFor={`${titleId}-cwd`}>
          Working directory
        </label>
        <Input
          id={`${titleId}-cwd`}
          value={cwd}
          placeholder={defaultCwd}
          onChange={(e) => setCwd(e.target.value)}
        />

        <label className={FIELD} htmlFor={`${titleId}-template`}>
          Template
        </label>
        <NativeSelect
          id={`${titleId}-template`}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">(none)</option>
          <optgroup label="Workflows">
            {templates
              .filter((t) => t.kind === 'workflow')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
          </optgroup>
          <optgroup label="Presets">
            {templates
              .filter((t) => t.kind === 'preset')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
          </optgroup>
        </NativeSelect>

        {template?.vars.map((v) => (
          <div key={v} className={FIELD}>
            <label htmlFor={`${titleId}-var-${v}`}>{VAR_LABEL[v]}</label>
            <Input
              id={`${titleId}-var-${v}`}
              value={vars[v] ?? ''}
              onChange={(e) => setVars({ ...vars, [v]: e.target.value })}
            />
          </div>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <div className={FIELD}>
            <label htmlFor={`${titleId}-ticket`}>Ticket</label>
            <Input
              id={`${titleId}-ticket`}
              value={ticket}
              placeholder="SAF-1787"
              onChange={(e) => setTicket(e.target.value)}
            />
          </div>
          <div className={FIELD}>
            <label htmlFor={`${titleId}-model`}>Model</label>
            <Input
              id={`${titleId}-model`}
              value={model}
              placeholder="default"
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
        </div>

        <label className={FIELD} htmlFor={`${titleId}-prompt`}>
          Prompt
        </label>
        <textarea
          id={`${titleId}-prompt`}
          className="min-h-24 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <LaunchPhase4Fields
          draft={draft}
          onChange={onDraftChange}
          repos={(worktrees.data ?? []).filter((w) => w.isMain).map((w) => w.path)}
        />

        <details className="rounded-md border p-2" open={(preset?.compare?.length ?? 0) > 0}>
          <summary className="cursor-pointer text-sm">
            Compare across agents{compare.length >= 2 ? ` (${compare.length})` : ''}
          </summary>
          <CompareLaunchSection projectId={projectId || null} value={compare} onChange={setCompare} />
        </details>

        {launch.error ? (
          <p role="alert" className="text-sm text-destructive">
            {describeLaunchError(launch.error)}
          </p>
        ) : null}

        {worktree ? (
          <p className="text-sm wrap-anywhere text-muted-foreground">
            {`Launching creates a worktree from ${worktree.base || 'main'} in ${worktree.repo || '(no repository)'} and starts the session there.`}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={launch.isPending}>
            Launch
          </Button>
        </div>
      </form>
    </>
  );
}
