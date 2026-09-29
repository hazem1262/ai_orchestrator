import type { AuditActor, AuditEntry } from '@orc/core';
import {
  BotIcon,
  ChevronRightIcon,
  SearchIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  UserIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { Fragment, useId, useMemo, useState } from 'react';
import { useAudit } from '@/api/queries/audit.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { Input } from '@/components/ui/input.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
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
const ACTOR_ICON: Record<AuditActor, typeof UserIcon> = {
  user: UserIcon,
  automation: ZapIcon,
  supervisor: BotIcon,
  remote: SmartphoneIcon,
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
  if (!entry.target) return <span className="text-muted-foreground">—</span>;
  return pk ? (
    <a
      className="block truncate text-primary underline-offset-2 hover:underline"
      href={`/sessions/${pk[1]}/${encodeURIComponent(pk[2] ?? '')}`}
    >
      {entry.target}
    </a>
  ) : (
    <span className="block truncate" title={entry.target}>
      {entry.target}
    </span>
  );
}

function ActorBadge({ entry }: { entry: AuditEntry }) {
  const Icon = ACTOR_ICON[entry.actor];
  return (
    <Badge variant="outline" className="capitalize" title={entry.actorDetail ?? undefined}>
      <Icon aria-hidden />
      {entry.actor}
    </Badge>
  );
}

function AuditDetails({ entry }: { entry: AuditEntry }) {
  return (
    <div className="flex flex-col gap-2">
      {entry.error && (
        <p data-testid={`audit-error-${entry.id}`} className="text-sm text-destructive">
          {entry.error}
        </p>
      )}
      <pre
        data-testid={`audit-params-${entry.id}`}
        className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap"
      >
        {JSON.stringify(entry.params, null, 2)}
      </pre>
    </div>
  );
}

function DetailsButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
      <ChevronRightIcon aria-hidden className={cn('transition-transform', expanded && 'rotate-90')} />
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
        <li key={e.id} className="min-w-0">
          <Card className="gap-2 p-3">
            <div className="flex items-center gap-2">
              <ActorBadge entry={e} />
              <Badge variant={RESULT_VARIANT[e.result]} className="ml-auto">
                {e.result}
              </Badge>
            </div>
            <p className="font-mono text-xs">{e.action}</p>
            <div className="min-w-0 font-mono text-xs">
              <AuditTarget entry={e} />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span title={e.ts}>{new Date(e.ts).toLocaleString()}</span>
              <span className="ml-auto">
                <DetailsButton expanded={open.has(e.id)} onToggle={() => toggle(e.id)} />
              </span>
            </div>
            {open.has(e.id) && <AuditDetails entry={e} />}
          </Card>
        </li>
      ))}
    </ul>
  );
}

function AuditSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading audit log" className="gap-0 py-0">
      {['a', 'b', 'c', 'd', 'e', 'f'].map((rowKey) => (
        <div key={rowKey} className="flex items-center gap-4 border-b px-3 py-3 last:border-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-5 w-12" />
        </div>
      ))}
    </Card>
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
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const isMobile = useIsMobile();
  const toggle = (entryId: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Audit log</h1>
      <form aria-label="Audit filters" className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="col-span-2 flex flex-col gap-1 sm:col-span-1 lg:col-span-2">
            <Label htmlFor={`${id}-search`}>Search</Label>
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                id={`${id}-search`}
                placeholder="Search target, params, errors"
                value={search.q ?? ''}
                onChange={(e) => onSearch(without(search, 'q', e.target.value))}
              />
            </InputGroup>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-actor`}>Actor</Label>
            <NativeSelect
              id={`${id}-actor`}
              className="w-full"
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
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-action`}>Action</Label>
            <Input
              id={`${id}-action`}
              className="w-full font-mono"
              placeholder="session.*"
              value={search.action ?? ''}
              onChange={(e) => onSearch(without(search, 'action', e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-session`}>Session</Label>
            <Input
              id={`${id}-session`}
              className="w-full font-mono"
              placeholder="claude:<id>"
              value={search.sessionPk ?? ''}
              onChange={(e) => onSearch(without(search, 'sessionPk', e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input
              id={`${id}-from`}
              type="date"
              className="w-full"
              value={search.from ? isoToLocalDay(search.from) : ''}
              onChange={(e) =>
                onSearch(
                  without(
                    search,
                    'from',
                    e.target.value ? localDayToIso(e.target.value, 'start') : undefined,
                  ),
                )
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-to`}>To</Label>
            <Input
              id={`${id}-to`}
              type="date"
              className="w-full"
              value={search.to ? isoToLocalDay(search.to) : ''}
              onChange={(e) =>
                onSearch(
                  without(search, 'to', e.target.value ? localDayToIso(e.target.value, 'end') : undefined),
                )
              }
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-project`}
              checked={search.projectId !== undefined}
              onCheckedChange={(checked) =>
                onSearch(without(search, 'projectId', checked && currentProject ? currentProject : undefined))
              }
            />
            <Label htmlFor={`${id}-project`}>Current project only</Label>
          </div>
          {q.data && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {q.data.length} {q.data.length === 1 ? 'entry' : 'entries'}
            </p>
          )}
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => onSearch({})}>
            <XIcon aria-hidden />
            Clear filters
          </Button>
        </div>
      </form>

      {q.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load the audit log</AlertTitle>
          <AlertDescription>Check the daemon connection, then try again.</AlertDescription>
        </Alert>
      ) : q.isLoading ? (
        <AuditSkeleton />
      ) : q.data && q.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No audit entries match these filters.</EmptyTitle>
            <EmptyDescription>Widen the date range or clear a filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : q.data && isMobile ? (
        <AuditCards entries={q.data} open={open} toggle={toggle} />
      ) : q.data ? (
        <Card className="gap-0 py-0">
          <Table aria-label="Audit entries">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((e) => (
                <Fragment key={e.id}>
                  <TableRow className={cn(open.has(e.id) && 'border-b-0 bg-muted/40')}>
                    <TableCell className="pl-3 text-xs text-muted-foreground" title={e.ts}>
                      {new Date(e.ts).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <ActorBadge entry={e} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="max-w-0 font-mono text-xs">
                      <AuditTarget entry={e} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={RESULT_VARIANT[e.result]}>{e.result}</Badge>
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <DetailsButton expanded={open.has(e.id)} onToggle={() => toggle(e.id)} />
                    </TableCell>
                  </TableRow>
                  {open.has(e.id) && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={6} className="px-3 pt-0 pb-3 whitespace-normal">
                        <AuditDetails entry={e} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
