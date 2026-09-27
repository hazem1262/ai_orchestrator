import { type FormEvent, useId, useState } from 'react';
import { useCancelReminder, useCreateReminder, useReminders } from '@/api/queries/work.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';

export function ReminderPanel({
  sessionPk,
  ticket,
  owned,
}: {
  sessionPk: string;
  ticket: string | null;
  owned: boolean;
}) {
  const id = useId();
  const list = useReminders({ sessionPk });
  const create = useCreateReminder();
  const cancel = useCancelReminder();
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState('20');
  const [send, setSend] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const inMinutes = Number(minutes);
    if (text.trim().length === 0 || !Number.isFinite(inMinutes) || inMinutes < 1) return;
    create.mutate(
      { sessionPk, ticket, text: text.trim(), inMinutes, sendToSession: send && owned },
      { onSuccess: () => setText('') },
    );
  }

  return (
    <section aria-label="Reminders" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Reminders</h3>
      <ul className="flex flex-col gap-1 text-xs">
        {(list.data ?? []).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2">
            <span>
              {r.text}{' '}
              <span className="text-muted-foreground">
                · due {r.dueAt.slice(11, 16)} UTC{r.sendToSession ? ' · sends to session' : ''}
              </span>
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Cancel reminder ${r.text}`}
              onClick={() => cancel.mutate(r.id)}
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 text-xs">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={`${id}-text`}>Reminder</label>
          <Input
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="re-check CI"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-minutes`}>In minutes</label>
          <Input
            id={`${id}-minutes`}
            type="number"
            min={1}
            className="w-20"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <div
          className="flex h-8 items-center gap-1"
          title={owned ? undefined : 'Only sessions this app owns can receive input'}
        >
          <Checkbox id={`${id}-send`} disabled={!owned} checked={send && owned} onCheckedChange={setSend} />
          <label htmlFor={`${id}-send`}>Also send it to the session</label>
        </div>
        <Button type="submit" size="sm" className="h-8" disabled={create.isPending}>
          Add reminder
        </Button>
      </form>
      {create.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not create the reminder.
        </p>
      ) : null}
      {cancel.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not cancel the reminder.
        </p>
      ) : null}
    </section>
  );
}
