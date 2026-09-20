import type { Availability, Source } from '@orc/core';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { DebouncedInput } from './DebouncedInput.tsx';
import type { HistorySearch } from './filters.ts';

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

export function HistoryFilters({
  search,
  onChange,
  onReset,
}: {
  search: HistorySearch;
  onChange(patch: Partial<HistorySearch>): void;
  onReset(): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <DebouncedInput
        type="search"
        aria-label="Search sessions"
        placeholder="Search prompts, answers, commands, names…"
        value={search.q ?? ''}
        onCommit={(q) => onChange({ q: orUndefined(q) })}
        className="w-full"
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
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
          onChange={(e) =>
            onChange({ availability: orUndefined(e.target.value) as Availability | undefined })
          }
        >
          <option value="">Any availability</option>
          <option value="resumable">Resumable</option>
          <option value="archived">Archived</option>
          <option value="prompts-only">Prompts only</option>
        </NativeSelect>
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
            className="w-28"
          />
        ))}
        <Input
          type="date"
          aria-label="From"
          value={search.from ?? ''}
          onChange={(e) => onChange({ from: orUndefined(e.target.value) })}
        />
        <Input
          type="date"
          aria-label="To"
          value={search.to ?? ''}
          onChange={(e) => onChange({ to: orUndefined(e.target.value) })}
        />
        <Input
          type="number"
          min={0}
          step="0.01"
          aria-label="Min cost"
          placeholder="Min $"
          className="w-20"
          value={search.minCost ?? ''}
          onChange={(e) => onChange({ minCost: numberOrUndefined(e.target.value) })}
        />
        <Input
          type="number"
          min={0}
          step="0.01"
          aria-label="Max cost"
          placeholder="Max $"
          className="w-20"
          value={search.maxCost ?? ''}
          onChange={(e) => onChange({ maxCost: numberOrUndefined(e.target.value) })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {TOGGLES.map(([key, label]) => (
          <span key={key} className="flex items-center gap-1">
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
        <Button variant="ghost" size="sm" onClick={onReset}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}
