import type { GoalState } from '@orc/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useGoal, useSetGoal } from '@/api/queries/work.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { GOAL_STATES } from './goal-format.ts';

export function GoalEditor({ targetType, targetId }: { targetType: 'session' | 'stream'; targetId: string }) {
  const id = useId();
  const q = useGoal(targetType, targetId);
  const save = useSetGoal(targetType, targetId);
  const [objective, setObjective] = useState('');
  const [state, setState] = useState<GoalState>('active');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!q.data) return;
    setObjective(q.data.goal?.objective ?? q.data.prefill);
    setState(q.data.goal?.state ?? 'active');
    setReason(q.data.goal?.blockedReason ?? '');
  }, [q.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate({
      objective: objective.trim(),
      state,
      blockedReason: state === 'blocked' ? reason.trim() || 'blocked' : null,
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" aria-label="Goal editor">
      <label htmlFor={`${id}-objective`} className="text-sm font-semibold">
        Goal
      </label>
      <Input
        id={`${id}-objective`}
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="What should this finish?"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={`${id}-state`}>Goal state</label>
        <NativeSelect
          id={`${id}-state`}
          className="h-7 text-xs"
          value={state}
          onChange={(e) => setState(e.target.value as GoalState)}
        >
          {GOAL_STATES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
        {state === 'blocked' ? (
          <>
            <label htmlFor={`${id}-reason`}>Blocked reason</label>
            <Input
              id={`${id}-reason`}
              className="h-7 flex-1 text-xs"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="needs answer"
            />
          </>
        ) : null}
        <Button type="submit" size="sm" disabled={save.isPending || objective.trim().length === 0}>
          Save goal
        </Button>
      </div>
      {save.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not save the goal.
        </p>
      ) : null}
    </form>
  );
}
