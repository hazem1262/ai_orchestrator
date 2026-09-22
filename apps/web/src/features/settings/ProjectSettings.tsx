import type { ProjectConfig } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { compileTicketRegex } from '@orc/core/browser';
import { useId, useMemo, useState } from 'react';
import { useProjectConfig, useProjects, useUpdateProject } from '@/api/queries/projects.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { buildProjectPatch, type ProjectFormValues } from './project-patch.ts';

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

function ProjectForm({ cfg, sessionCount }: { cfg: ProjectConfig; sessionCount: number }) {
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

  const regexErrorId = `${id}-regex-error`;
  const prefixesErrorId = `${id}-prefixes-error`;
  const formErrorId = `${id}-form-error`;

  const submit = () => {
    if (!canSave) return;
    update.mutate({ id: cfg.id, patch });
  };

  return (
    <fieldset className="grid grid-cols-[8rem_1fr] items-start gap-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">
        {cfg.id} · {sessionCount} sessions
      </legend>

      <label htmlFor={`${id}-name`} className="pt-1 text-sm">
        Name
      </label>
      <Input id={`${id}-name`} value={values.name} onChange={(e) => set('name', e.target.value)} />

      <label htmlFor={`${id}-prefixes`} className="pt-1 text-sm">
        Paths
      </label>
      <div className="flex flex-col gap-1">
        <textarea
          id={`${id}-prefixes`}
          rows={Math.max(2, values.prefixes.split('\n').length)}
          className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
          value={values.prefixes}
          onChange={(e) => set('prefixes', e.target.value)}
          aria-invalid={prefixesInvalid ? true : undefined}
          aria-describedby={prefixesInvalid ? prefixesErrorId : undefined}
        />
        {prefixesInvalid ? (
          <p id={prefixesErrorId} role="alert" className="text-sm text-destructive">
            Paths must be absolute — "{invalidPrefix}" does not start with "/"
          </p>
        ) : null}
      </div>

      <label htmlFor={`${id}-open`} className="pt-1 text-sm">
        Open in
      </label>
      <NativeSelect
        id={`${id}-open`}
        value={values.openIn}
        onChange={(e) => set('openIn', e.target.value as ProjectFormValues['openIn'])}
        className="w-40"
      >
        {OPEN_IN.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </NativeSelect>

      <label htmlFor={`${id}-regex`} className="pt-1 text-sm">
        Ticket regex
      </label>
      <div className="flex flex-col gap-1">
        <Input
          id={`${id}-regex`}
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

      <label htmlFor={`${id}-hidden`} className="text-sm">
        Hidden
      </label>
      <Checkbox id={`${id}-hidden`} checked={values.hidden} onCheckedChange={(v) => set('hidden', v)} />

      <div />
      <div className="flex items-center gap-3">
        <Button disabled={!canSave} onClick={submit}>
          Save
        </Button>
        {update.isError ? (
          <p id={formErrorId} role="alert" className="text-sm text-destructive">
            {update.error.message}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const { data: cfg, isError, error, refetch, isFetching } = useProjectConfig(project.id);
  if (isError) {
    return (
      <fieldset className="rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{project.name}</legend>
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            Couldn't load settings for {project.name}:{' '}
            {error instanceof Error ? error.message : 'unknown error'}
          </p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </fieldset>
    );
  }
  if (!cfg) return <Skeleton className="h-48" />;
  // Remounting on a config change (id unchanged, content changed) resets local edits to the
  // last confirmed server value — only happens after a successful save, never after a failure.
  return <ProjectForm key={JSON.stringify(cfg)} cfg={cfg} sessionCount={project.sessionCount} />;
}

export function ProjectSettings() {
  const { data: projects, isLoading } = useProjects();
  return (
    <section className="flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Projects</h1>
      <p className="text-sm text-muted-foreground">
        Projects are detected from your session history. Hiding a project only hides it here; nothing is
        deleted.
      </p>
      {isLoading ? <Skeleton className="h-48" /> : null}
      {(projects ?? []).map((p) => (
        <ProjectRow key={p.id} project={p} />
      ))}
    </section>
  );
}
