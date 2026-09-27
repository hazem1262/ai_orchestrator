import type { TemplateVar } from '@orc/api-contract';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';

/** Asks for the values of the template's `{{var}}` placeholders before a manual run. */
export function RunVarsDialog({
  name,
  vars,
  busy,
  onRun,
  onClose,
}: {
  name: string;
  vars: TemplateVar[];
  busy: boolean;
  onRun(values: Partial<Record<TemplateVar, string>>): void;
  onClose(): void;
}) {
  const id = useId();
  const [values, setValues] = useState<Partial<Record<TemplateVar, string>>>({});
  const complete = vars.every((v) => (values[v] ?? '').trim() !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    onRun(Object.fromEntries(vars.map((v) => [v, (values[v] ?? '').trim()])));
  };
  return (
    <GitDialog title={`Run "${name}"`} description="The template needs these values." onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {vars.map((v) => (
          <div key={v} className="flex flex-col gap-1 text-sm">
            <label htmlFor={`${id}-${v}`}>{v}</label>
            <Input
              id={`${id}-${v}`}
              value={values[v] ?? ''}
              onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))}
            />
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!complete || busy}>
            Run
          </Button>
        </div>
      </form>
    </GitDialog>
  );
}
