import type { AuditActor, AuditEntry } from '@orc/core';
import { Fragment, useId, useMemo, useState } from 'react';
import { useAudit } from '@/api/queries/audit.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
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

function AuditTarget({ entry }: { entry: AuditEntry }) {
  const pk = entry.target ? PK_RE.exec(entry.target) : null;
  return pk ? (
    <a
      className="text-primary underline-offset-2 hover:underline"
      href={`/sessions/${pk[1]}/${encodeURIComponent(pk[2] ?? '')}`}
    >
      {entry.target}
    </a>
  ) : (
    (entry.target ?? '—')
  );
}

function AuditDetails({ entry }: { entry: AuditEntry }) {
  return (
    <>
      {entry.error && (
        <p data-testid={`audit-error-${entry.id}`} className="mb-1 text-destructive">
          {entry.error}
        </p>
      )}
      <pre
        data-testid={`audit-params-${entry.id}`}
        className="whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted p-2 font-mono text-xs"
      >
        {JSON.stringify(entry.params, null, 2)}
      </pre>
    </>
  );
}

function DetailsButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
      Details
    </Button>
  );
}

/** The phone layout of the log: one card per entry instead of a six-column table. */
function AuditCards({
  entries,
  open,
  toggle,
}: {
  entries: AuditEntry[];
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {entries.map((e) => (
        <li key={e.id} className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">{e.action}</span>
            <Badge variant={RESULT_VARIANT[e.result]} className="ml-auto">
              {e.result}
            </Badge>
          </div>
          <p className="font-mono text-xs break-all">
            <AuditTarget entry={e} />
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span title={e.actorDetail ?? undefined}>{e.actor}</span>
            <span title={e.ts}>{new Date(e.ts).toLocaleString()}</span>
            <span className="ml-auto">
              <DetailsButton expanded={open.has(e.id)} onToggle={() => toggle(e.id)} />
            </span>
          </div>
          {open.has(e.id) && (
            <div>
              <AuditDetails entry={e} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
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
  const isMobile = useIsMobile();
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
      {q.data && q.data.length > 0 && isMobile && <AuditCards entries={q.data} open={open} toggle={toggle} />}
      {q.data && q.data.length > 0 && !isMobile && (
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
                      <AuditTarget entry={e} />
                    </td>
                    <td className="py-1 pr-2">
                      <Badge variant={RESULT_VARIANT[e.result]}>{e.result}</Badge>
                    </td>
                    <td className="py-1">
                      <DetailsButton expanded={open.has(e.id)} onToggle={() => toggle(e.id)} />
                    </td>
                  </tr>
                  {open.has(e.id) && (
                    <tr>
                      <td colSpan={6} className="pb-2">
                        <AuditDetails entry={e} />
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
