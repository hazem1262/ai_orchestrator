import type { SupervisorIntent } from '@orc/api-contract';
import { type FormEvent, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { supervisorKeys, useAddSupervisorRule, useSupervisorRules } from '@/api/queries/supervisor.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { ConfirmActionDialog } from '@/features/automations/ConfirmActionDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';

const INTENTS: Array<{ value: SupervisorIntent; label: string }> = [
  { value: 'continue', label: 'Continue' },
  { value: 'run_tests', label: 'Run the tests' },
  { value: 'proceed_plan', label: 'Proceed with the approved plan' },
  { value: 'retry_transient', label: 'Retry a transient failure' },
];

const field = 'flex min-w-0 flex-col gap-1 text-sm';

/**
 * User and feedback rules. Built-in allow and deny patterns live in the daemon and are not listed
 * here. Deleting goes out unconfirmed first; the daemon's `409 confirmation_required` summary is
 * shown in a dialog and confirming it resends with `confirm: true`.
 */
export function SupervisorRules() {
  const { data: rules = [], isLoading } = useSupervisorRules();
  const add = useAddSupervisorRule();
  const remove = useConfirmedMutation(
    (id: string, confirm: boolean) => getApiClient().supervisorDeleteRule(id, confirm),
    { invalidate: [supervisorKeys.rules] },
  );
  const [kind, setKind] = useState<'allow' | 'deny'>('deny');
  const [pattern, setPattern] = useState('');
  const [intent, setIntent] = useState<SupervisorIntent>('continue');
  const [answer, setAnswer] = useState('');

  const ready = pattern.trim().length >= 2 && (kind === 'deny' || answer.trim().length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    add.mutate(
      {
        projectId: null,
        kind,
        pattern: pattern.trim(),
        intent: kind === 'allow' ? intent : null,
        answer: kind === 'allow' ? answer.trim() : null,
        note: null,
      },
      {
        onSuccess: () => {
          setPattern('');
          setAnswer('');
        },
      },
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="supervisor-rules">
      <h3 id="supervisor-rules" className="text-sm font-semibold">
        Rules
      </h3>
      <p className="text-xs text-muted-foreground">
        Patterns are case-insensitive regular expressions matched against the agent's question. A deny rule
        always escalates; an allow rule maps a question to one of the routine intents.
      </p>
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {!isLoading && rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rules of your own yet.</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {rules.map((r) => (
          <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded border p-2 text-sm">
            <Badge variant={r.kind === 'deny' ? 'destructive' : 'success'}>{r.kind}</Badge>
            <code className="min-w-0 break-all text-xs">{r.pattern}</code>
            {r.intent ? <Badge variant="outline">{r.intent}</Badge> : null}
            {r.answer ? (
              <span className="break-words text-xs text-muted-foreground">→ {r.answer}</span>
            ) : null}
            <span className="text-xs text-muted-foreground">{r.source}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-destructive"
              aria-label={`Delete rule ${r.pattern}`}
              disabled={remove.busy}
              onClick={() => void remove.run(r.id)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label="Add a supervisor rule"
        onSubmit={submit}
        className="grid grid-cols-1 gap-2 rounded border p-3 sm:grid-cols-2"
      >
        <label className={field} htmlFor="sup-rule-kind">
          Kind
          <NativeSelect
            id="sup-rule-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value === 'allow' ? 'allow' : 'deny')}
          >
            <option value="deny">Deny (always escalate)</option>
            <option value="allow">Allow (routine intent)</option>
          </NativeSelect>
        </label>
        <label className={field} htmlFor="sup-rule-pattern">
          Pattern
          <Input
            id="sup-rule-pattern"
            value={pattern}
            placeholder="migrat(e|ion)"
            onChange={(e) => setPattern(e.target.value)}
          />
        </label>
        {kind === 'allow' ? (
          <>
            <label className={field} htmlFor="sup-rule-intent">
              Intent
              <NativeSelect
                id="sup-rule-intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value as SupervisorIntent)}
              >
                {INTENTS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className={field} htmlFor="sup-rule-answer">
              Answer the supervisor types
              <Input
                id="sup-rule-answer"
                value={answer}
                placeholder="Yes, continue."
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" size="sm" disabled={add.isPending || !ready}>
            Add rule
          </Button>
          {add.error ? <span className="text-xs text-destructive">{add.error.message}</span> : null}
        </div>
      </form>
      {remove.error ? <p className="text-xs text-destructive">{remove.error.message}</p> : null}
      <ConfirmActionDialog
        request={remove.pending}
        busy={remove.busy}
        title="Delete supervisor rule?"
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove.confirm()}
        onCancel={remove.cancel}
      />
    </section>
  );
}
