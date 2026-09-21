import { type FormEvent, useState } from 'react';
import { useDeleteView, useSavedViews, useSaveView } from '@/api/queries/views.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { type HistorySearch, searchToViewQuery, viewQueryToSearch } from './filters.ts';

export function SavedViews({ search, onApply }: { search: HistorySearch; onApply(s: HistorySearch): void }) {
  const views = useSavedViews();
  const save = useSaveView();
  const remove = useDeleteView();
  const [name, setName] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate({ name: name.trim(), query: searchToViewQuery(search) });
    setName('');
  };

  return (
    <section aria-label="Saved views" className="flex flex-wrap items-center gap-1">
      {(views.data ?? []).map((v) => (
        <span key={v.id} className="inline-flex items-center rounded-md border">
          <Button size="sm" variant="ghost" onClick={() => onApply(viewQueryToSearch(v.query))}>
            {v.name}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Delete view ${v.name}`}
            onClick={() => remove.mutate(v.id)}
          >
            ×
          </Button>
        </span>
      ))}
      <form onSubmit={submit} className="flex items-center gap-1">
        <Input
          aria-label="View name"
          placeholder="Save current filters as…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 w-44"
        />
        <Button size="sm" type="submit" variant="outline" disabled={!name.trim()}>
          Save view
        </Button>
      </form>
    </section>
  );
}
