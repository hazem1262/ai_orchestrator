import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { type FormEvent, useState } from 'react';
import { useSetLabels } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';

export function LabelEditor({ item }: { item: SessionListItem }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const setLabels = useSetLabels();
  const visible = item.labels.filter((l) => l !== HIDDEN_LABEL);

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setValue(visible.join(', '));
          setEditing(true);
        }}
      >
        Labels
      </Button>
    );
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = value
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    const keep = item.labels.includes(HIDDEN_LABEL) ? [HIDDEN_LABEL] : [];
    setLabels.mutate({ source: item.source, id: item.id, labels: [...new Set([...next, ...keep])] });
    setEditing(false);
  };

  return (
    <form onSubmit={save} className="flex items-center gap-1">
      <Input
        aria-label="Labels"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-28"
      />
      <Button size="sm" type="submit">
        Save
      </Button>
    </form>
  );
}

export function HideToggle({ item }: { item: SessionListItem }) {
  const setLabels = useSetLabels();
  const hidden = item.labels.includes(HIDDEN_LABEL);
  const labels = hidden ? item.labels.filter((l) => l !== HIDDEN_LABEL) : [...item.labels, HIDDEN_LABEL];
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setLabels.mutate({ source: item.source, id: item.id, labels })}
    >
      {hidden ? 'Unhide' : 'Hide'}
    </Button>
  );
}
