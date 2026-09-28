import type { ProjectConfig } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { compileTicketRegex } from '@orc/core/browser';
import { FolderOpen, Pencil } from 'lucide-react';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { useProjectConfig, useProjects, useUpdateProject } from '@/api/queries/projects.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useFocusReturn } from '@/components/ui/use-focus-return.ts';
import { shortenPath } from '@/lib/format.ts';
import { buildProjectPatch, type ProjectFormValues } from './project-patch.ts';
import { SettingsCard } from './SettingsCard.tsx';

const OPEN_IN: ProjectFormValues['openIn'][] = ['vscode', 'terminal', 'finder'];
/** Mirrors the daemon's `ServiceError` message (apps/daemon/src/http/routes/projects.ts) so the
 *  inline error reads the same whether it is caught here or bounced back by the server. */
const REGEX_ERROR = 'ticketRegex is not a valid regular expression';

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Mirrors `ProjectPatchSchema.pathPrefixes` (`z.string().startsWith('/')`) — "a path prefix must
 *  be absolute" is a product rule, not just a daemon quirk, so it is checked here too. */
function firstRelativePrefix(text: string): string | null {
  return nonEmptyLines(text).find((p) => !p.startsWith('/')) ?? null;
}

function ProjectForm({ cfg, onSaved }: { cfg: ProjectConfig; onSaved(): void }) {
  const update = useUpdateProject();
  const id = useId();
  const [values, setValues] = useState<ProjectFormValues>({
    name: cfg.name,
    prefixes: cfg.pathPrefixes.join('\n'),
    hidden: cfg.hidden,
    openIn: cfg.openIn,
    ticketRegex: cfg.ticketRegex ?? '',
  });
  const set = <K extends keyof ProjectFormValues>(k: K, v: ProjectFormValues[K]) => {
    if (update.isError) update.reset();
    setValues((prev) => ({ ...prev, [k]: v }));
  };

  // Client-side check before it ever leaves the browser: same rule (`new RegExp`) the daemon
  // applies, so a bad pattern never makes a wasted round trip and never gets sent at all.
  const trimmedRegex = values.ticketRegex.trim();
  const regexInvalid = trimmedRegex !== '' && compileTicketRegex(trimmedRegex) === null;

  const invalidPrefix = firstRelativePrefix(values.prefixes);
  const prefixesInvalid = invalidPrefix !== null;

  const patch = useMemo(() => buildProjectPatch(cfg, values), [cfg, values]);
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && !regexInvalid && !prefixesInvalid && !update.isPending;

  const f = (name: string) => `${id}-${name}`;
  const regexErrorId = f('regex-error');
  const prefixesErrorId = f('prefixes-error');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    update.mutate({ id: cfg.id, patch }, { onSuccess: onSaved });
  };

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-5 px-4 pb-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={f('name')}>Name</Label>
        <Input id={f('name')} value={values.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={f('prefixes')}>Paths</Label>
        <Textarea
          id={f('prefixes')}
          rows={Math.max(2, values.prefixes.split('\n').length)}
          className="font-mono text-xs md:text-xs"
          value={values.prefixes}
          onChange={(e) => set('prefixes', e.target.value)}
          aria-invalid={prefixesInvalid ? true : undefined}
          aria-describedby={prefixesInvalid ? prefixesErrorId : f('prefixes-hint')}
        />
        {prefixesInvalid ? (
          <p id={prefixesErrorId} role="alert" className="text-sm text-destructive">
            Paths must be absolute — "{invalidPrefix}" does not start with "/"
          </p>
        ) : (
          <p id={f('prefixes-hint')} className="text-xs text-muted-foreground">
            One absolute path per line. Sessions under these folders belong to this project.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={f('open')}>Open in</Label>
        <NativeSelect
          id={f('open')}
          value={values.openIn}
          onChange={(e) => set('openIn', e.target.value as ProjectFormValues['openIn'])}
        >
          {OPEN_IN.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={f('regex')}>Ticket regex</Label>
        <Input
          id={f('regex')}
          className="font-mono"
          value={values.ticketRegex}
          onChange={(e) => set('ticketRegex', e.target.value)}
          aria-invalid={regexInvalid ? true : undefined}
          aria-describedby={regexInvalid ? regexErrorId : undefined}
        />
        {regexInvalid ? (
          <p id={regexErrorId} role="alert" className="text-sm text-destructive">
            {REGEX_ERROR}
          </p>
        ) : null}
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id={f('hidden')}
          className="mt-0.5"
          checked={values.hidden}
          onCheckedChange={(v) => set('hidden', v)}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={f('hidden')}>Hidden</Label>
          <p className="text-xs text-muted-foreground">Hides the project in lists. Nothing is deleted.</p>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-end gap-3 border-t pt-4">
        {update.isError ? (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {update.error.message}
          </p>
        ) : null}
        <Button type="submit" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  );
}

function ProjectEditor({ project, onSaved }: { project: Project; onSaved(): void }) {
  const { data: cfg, isError, error, refetch, isFetching } = useProjectConfig(project.id);
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-3 px-4">
        <p role="alert" className="text-sm text-destructive">
          Couldn't load settings for {project.name}:{' '}
          {error instanceof Error ? error.message : 'unknown error'}
        </p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!cfg) return <Skeleton className="mx-4 h-64" />;
  // Remounting on a config change (id unchanged, content changed) resets local edits to the
  // last confirmed server value — only happens after a successful save, never after a failure.
  return <ProjectForm key={JSON.stringify(cfg)} cfg={cfg} onSaved={onSaved} />;
}

function ProjectRow({ project, onEdit }: { project: Project; onEdit(): void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <div className={cn('min-w-0 flex-1 basis-40', project.hidden && 'opacity-70')}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {project.name}
          <span className="font-mono text-xs font-normal text-muted-foreground">{project.id}</span>
          {project.hidden ? <Badge variant="secondary">hidden</Badge> : null}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {project.pathPrefixes.map(shortenPath).join(', ')} · {project.sessionCount} sessions
        </p>
      </div>
      <Button size="sm" variant="outline" aria-label={`Edit ${project.name}`} onClick={onEdit}>
        <Pencil aria-hidden />
        Edit
      </Button>
    </li>
  );
}

export function ProjectSettings() {
  const { data: projects, isLoading } = useProjects();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = (projects ?? []).find((p) => p.id === editingId) ?? null;
  const returnFocus = useFocusReturn(editing !== null);
  const close = () => setEditingId(null);
  return (
    <SettingsCard
      label="Projects"
      title="Projects"
      description="Projects are detected from your session history. Hiding a project only hides it here; nothing is deleted."
    >
      {isLoading ? <Skeleton className="h-48" /> : null}
      {projects && projects.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No projects detected yet</EmptyTitle>
            <EmptyDescription>Projects appear once sessions have run in a folder.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {projects && projects.length > 0 ? (
        <ul className="-my-2 flex flex-col divide-y">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} onEdit={() => setEditingId(p.id)} />
          ))}
        </ul>
      ) : null}
      <Sheet open={editing !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md" onCloseAutoFocus={returnFocus}>
          <SheetHeader>
            <SheetTitle>Edit {editing?.name}</SheetTitle>
            <SheetDescription className="font-mono">
              {editing ? `${editing.id} · ${editing.sessionCount} sessions` : null}
            </SheetDescription>
          </SheetHeader>
          {editing ? <ProjectEditor key={editing.id} project={editing} onSaved={close} /> : null}
        </SheetContent>
      </Sheet>
    </SettingsCard>
  );
}
