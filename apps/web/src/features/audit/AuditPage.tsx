import type { AuditActor, AuditEntry } from '@orc/core';
import { Fragment, useId, useMemo, useState } from 'react';
import { useAudit } from '@/api/queries/audit.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useProjectStore } from '@/stores/project.ts';

export interface AuditSearch {
  sessionPk?: string;
  action?: string;
  actor?: AuditActor;
  from?: string;
  to?: string;
  q?: string;
  projectId?: string;
}

const ACTORS: AuditActor[] = ['user', 'automation', 'supervisor', 'remote'];
const PK_RE = /^(claude|codex|agnc):(.+)$/;
const RESULT_VARIANT: Record<AuditEntry['result'], BadgeVariant> = {
  ok: 'success',
  error: 'destructive',
  denied: 'warning',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function localDayToIso(day: string, edge: 'start' | 'end'): string {
  const [y, m, d] = day.split('-').map(Number);
  const date =
    edge === 'start'
      ? new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
      : new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
  return date.toISOString();
}

export function isoToLocalDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function without<K extends keyof AuditSearch>(
  s: AuditSearch,
  key: K,
  value: AuditSearch[K] | undefined,
): AuditSearch {
  const next: AuditSearch = { ...s };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const filter = useMemo(() => ({ ...search, limit: 500 }), [search]);
  const q = useAudit(filter);
  const currentProject = useProjectStore((s) => s.projectId);
  const projectOnlyId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Audit log</h1>
      <form
        aria-label="Audit filters"
        className="mb-3 flex flex-wrap items-center gap-2 text-sm"
        onSubmit={(e) => e.preventDefault()}
      >
        <Input
          aria-label="Search"
          placeholder="Search target, params, errors"
          value={search.q ?? ''}
          onChange={(e) => onSearch(without(search, 'q', e.target.value))}
        />
        <NativeSelect
          aria-label="Actor"
          value={search.actor ?? ''}
          onChange={(e) =>
            onSearch(without(search, 'actor', (e.target.value || undefined) as AuditActor | undefined))
          }
        >
          <option value="">any actor</option>
          {ACTORS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </NativeSelect>
        <Input
          aria-label="Action"
          placeholder="session.*"
          value={search.action ?? ''}
          onChange={(e) => onSearch(without(search, 'action', e.target.value))}
        />
        <Input
          aria-label="Session"
          placeholder="claude:<id>"
          value={search.sessionPk ?? ''}
          onChange={(e) => onSearch(without(search, 'sessionPk', e.target.value))}
        />
        <Input
          aria-label="From"
          type="date"
          value={search.from ? isoToLocalDay(search.from) : ''}
          onChange={(e) =>
            onSearch(
              without(search, 'from', e.target.value ? localDayToIso(e.target.value, 'start') : undefined),
            )
          }
        />
        <Input
          aria-label="To"
          type="date"
          value={search.to ? isoToLocalDay(search.to) : ''}
          onChange={(e) =>
            onSearch(without(search, 'to', e.target.value ? localDayToIso(e.target.value, 'end') : undefined))
          }
        />
        <span className="inline-flex items-center gap-1">
          <Checkbox
            id={projectOnlyId}
            checked={search.projectId !== undefined}
            onCheckedChange={(checked) =>
              onSearch(without(search, 'projectId', checked && currentProject ? currentProject : undefined))
            }
          />
          <label htmlFor={projectOnlyId}>Current project only</label>
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => onSearch({})}>
          Clear filters
        </Button>
      </form>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the audit log.
        </p>
      )}
      {q.data && q.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No audit entries match these filters.</p>
      )}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Time</th>
              <th className="py-1 pr-2 font-medium">Actor</th>
              <th className="py-1 pr-2 font-medium">Action</th>
              <th className="py-1 pr-2 font-medium">Target</th>
              <th className="py-1 pr-2 font-medium">Result</th>
              <th className="py-1">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => {
              const pk = e.target ? PK_RE.exec(e.target) : null;
              return (
                <Fragment key={e.id}>
                  <tr className="border-t">
                    <td className="py-1 pr-2 whitespace-nowrap" title={e.ts}>
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td className="py-1 pr-2" title={e.actorDetail ?? undefined}>
                      {e.actor}
                    </td>
                    <td className="py-1 pr-2 font-mono text-xs">{e.action}</td>
                    <td className="py-1 pr-2 font-mono text-xs">
                      {pk ? (
                        <a
                          className="text-primary underline-offset-2 hover:underline"
                          href={`/sessions/${pk[1]}/${encodeURIComponent(pk[2] ?? '')}`}
                        >
                          {e.target}
                        </a>
                      ) : (
                        (e.target ?? '—')
                      )}
                    </td>
                    <td className="py-1 pr-2">
                      <Badge variant={RESULT_VARIANT[e.result]}>{e.result}</Badge>
                    </td>
                    <td className="py-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-expanded={open.has(e.id)}
                        onClick={() => toggle(e.id)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                  {open.has(e.id) && (
                    <tr>
                      <td colSpan={6} className="pb-2">
                        {e.error && (
                          <p data-testid={`audit-error-${e.id}`} className="mb-1 text-destructive">
                            {e.error}
                          </p>
                        )}
                        <pre
                          data-testid={`audit-params-${e.id}`}
                          className="whitespace-pre-wrap rounded-md border bg-muted p-2 font-mono text-xs"
                        >
                          {JSON.stringify(e.params, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
