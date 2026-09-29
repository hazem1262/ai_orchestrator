import type { Availability, Source } from '@orc/core';
import { ListFilter, RotateCcw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet.tsx';
import { DebouncedInput } from './DebouncedInput.tsx';
import { cleanSearch, type HistorySearch, secondaryFilterCount } from './filters.ts';

type BoolKey = 'touchedProd' | 'hasSubagents' | 'pinned' | 'includeHidden' | 'includeAutomated';
const TOGGLES: Array<[BoolKey, string]> = [
  ['touchedProd', 'Touched prod'],
  ['hasSubagents', 'Has subagents'],
  ['pinned', 'Pinned'],
  ['includeHidden', 'Show hidden'],
  ['includeAutomated', 'Show automated'],
];
type TextKey = 'ticket' | 'pr' | 'model' | 'skill' | 'label';
const TEXTS: Array<[TextKey, string]> = [
  ['ticket', 'Ticket'],
  ['pr', 'PR'],
  ['model', 'Model'],
  ['skill', 'Skill'],
  ['label', 'Label'],
];

const orUndefined = (v: string) => (v === '' ? undefined : v);
const numberOrUndefined = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

function FiltersSheet({
  search,
  onChange,
}: {
  search: HistorySearch;
  onChange(patch: Partial<HistorySearch>): void;
}) {
  const count = secondaryFilterCount(search);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter />
          Filters
          {count ? <Badge variant="secondary">{count}</Badge> : null}
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined} className="gap-0 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Ticket, PR, model, skill, label, date, cost and visibility.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <div className="grid grid-cols-2 gap-2">
            {TEXTS.map(([key, label]) => (
              <DebouncedInput
                key={key}
                aria-label={label}
                placeholder={label}
                value={search[key] ?? ''}
                onCommit={(v) => {
                  const patch: Partial<HistorySearch> = {};
                  patch[key] = orUndefined(v);
                  onChange(patch);
                }}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span aria-hidden>From</span>
              <Input
                type="date"
                aria-label="From"
                value={search.from ?? ''}
                onChange={(e) => onChange({ from: orUndefined(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span aria-hidden>To</span>
              <Input
                type="date"
                aria-label="To"
                value={search.to ?? ''}
                onChange={(e) => onChange({ to: orUndefined(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span aria-hidden>Min cost</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                aria-label="Min cost"
                placeholder="Min $"
                value={search.minCost ?? ''}
                onChange={(e) => onChange({ minCost: numberOrUndefined(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span aria-hidden>Max cost</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                aria-label="Max cost"
                placeholder="Max $"
                value={search.maxCost ?? ''}
                onChange={(e) => onChange({ maxCost: numberOrUndefined(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            {TOGGLES.map(([key, label]) => (
              <span key={key} className="flex items-center gap-2">
                <Checkbox
                  id={`history-filter-${key}`}
                  checked={search[key] === true}
                  onCheckedChange={(v) => {
                    const patch: Partial<HistorySearch> = {};
                    patch[key] = v || undefined;
                    onChange(patch);
                  }}
                />
                <label htmlFor={`history-filter-${key}`}>{label}</label>
              </span>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function HistoryFilters({
  search,
  onChange,
  onReset,
}: {
  search: HistorySearch;
  onChange(patch: Partial<HistorySearch>): void;
  onReset(): void;
}) {
  const active = Object.keys(cleanSearch(search)).length > 0;
  return (
    <search className="flex flex-wrap items-center gap-2">
      <div className="relative w-full md:w-72">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <DebouncedInput
          type="search"
          aria-label="Search sessions"
          placeholder="Search prompts, answers, commands, names…"
          value={search.q ?? ''}
          onCommit={(q) => onChange({ q: orUndefined(q) })}
          className="w-full pl-8"
        />
      </div>
      <NativeSelect
        aria-label="Source"
        value={search.source ?? ''}
        onChange={(e) => onChange({ source: orUndefined(e.target.value) as Source | undefined })}
      >
        <option value="">All sources</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </NativeSelect>
      <NativeSelect
        aria-label="Availability"
        value={search.availability ?? ''}
        onChange={(e) => onChange({ availability: orUndefined(e.target.value) as Availability | undefined })}
      >
        <option value="">Any availability</option>
        <option value="resumable">Resumable</option>
        <option value="archived">Archived</option>
        <option value="prompts-only">Prompts only</option>
      </NativeSelect>
      <FiltersSheet search={search} onChange={onChange} />
      {active ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw />
          Clear filters
        </Button>
      ) : null}
    </search>
  );
}
