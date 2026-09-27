import type { LimitsConfig } from '@orc/api-contract';
import type { BudgetPeriod, BudgetScopeType } from '@orc/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useSettings, useUpdateSettings } from '@/api/queries/settings.ts';
import { useBudgets, useConcurrency, useDeleteBudget, useUpsertBudget } from '@/api/queries/usage.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { formatPctValue, formatUsd, quotaTone } from '@/features/limits/format.ts';
import { NumberInput } from './NumberInput.tsx';

const SCOPES: BudgetScopeType[] = ['global', 'project', 'ticket'];
const PERIODS: BudgetPeriod[] = ['daily', 'weekly', 'monthly'];
const TONE_CLASS = { ok: '', warn: 'text-warning', over: 'text-destructive' } as const;

export function LimitsSettings() {
  const id = useId();
  const q = useSettings();
  const save = useUpdateSettings();
  const budgets = useBudgets();
  const upsert = useUpsertBudget();
  const remove = useDeleteBudget();
  const concurrency = useConcurrency();
  const [form, setForm] = useState<LimitsConfig | null>(null);
  const [scopeType, setScopeType] = useState<BudgetScopeType>('project');
  const [scopeId, setScopeId] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('daily');
  const [limitUsd, setLimitUsd] = useState('50');

  useEffect(() => {
    if (q.data) setForm(q.data.limits);
  }, [q.data]);

  if (!form) {
    return (
      <section aria-label="Limits & budgets" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Limits & budgets</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  function onSaveLimits(e: FormEvent) {
    e.preventDefault();
    if (form) save.mutate({ limits: form });
  }

  function onAddBudget(e: FormEvent) {
    e.preventDefault();
    const usd = Number(limitUsd);
    if (!Number.isFinite(usd) || usd <= 0) return;
    const target = scopeId.trim();
    if (scopeType !== 'global' && target === '') return;
    upsert.mutate({ scopeType, scopeId: scopeType === 'global' ? null : target, period, limitUsd: usd });
  }

  const f = (name: string) => `${id}-${name}`;
  return (
    <section aria-label="Limits & budgets" className="flex flex-col gap-3 text-sm">
      <h2 className="text-base font-semibold">Limits & budgets</h2>
      <p className="text-muted-foreground">
        {`Quota figures are ${
          form.quotaSource === 'estimate'
            ? 'estimated from transcripts (like ccusage)'
            : 'read from the official statusline source'
        }. Set your plan's token limits to turn the bars into percentages.`}
      </p>
      <form onSubmit={onSaveLimits} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={f('block')}>5-hour token limit</label>
          <NumberInput
            id={f('block')}
            className="w-32"
            min={0}
            value={form.blockTokenLimit}
            onValue={(n) => setForm({ ...form, blockTokenLimit: n === null ? null : Math.trunc(n) || null })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('week')}>7-day token limit</label>
          <NumberInput
            id={f('week')}
            className="w-32"
            min={0}
            value={form.weekTokenLimit}
            onValue={(n) => setForm({ ...form, weekTokenLimit: n === null ? null : Math.trunc(n) || null })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('warn')}>Warn at</label>
          <NumberInput
            id={f('warn')}
            className="w-20"
            min={0}
            max={1}
            step="0.05"
            value={form.warnPct}
            onValue={(n) => {
              if (n !== null) setForm({ ...form, warnPct: n });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('ctx-warn')}>Context warning at</label>
          <NumberInput
            id={f('ctx-warn')}
            className="w-20"
            min={0}
            max={1}
            step="0.05"
            value={form.contextWarnFill}
            onValue={(n) => {
              if (n !== null) setForm({ ...form, contextWarnFill: n });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('ctx-default')}>Default context window</label>
          <NumberInput
            id={f('ctx-default')}
            className="w-28"
            min={1000}
            value={form.defaultContextWindow}
            onValue={(n) => {
              if (n !== null) setForm({ ...form, defaultContextWindow: n });
            }}
          />
        </div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save limits
        </Button>
        {save.isError ? (
          <span role="alert" className="text-destructive">
            Could not save.
          </span>
        ) : null}
      </form>

      <table className="w-full text-left">
        <caption className="text-left text-muted-foreground">
          Budgets. Budgets from a project's configuration are edited in that project's settings.
        </caption>
        <thead>
          <tr className="text-muted-foreground">
            <th>scope</th>
            <th>period</th>
            <th>spent</th>
            <th>limit</th>
            <th>used</th>
            <th>
              <span className="sr-only">actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(budgets.data ?? []).map((s) => (
            <tr key={s.budget.id}>
              <td>
                {s.budget.scopeType === 'global'
                  ? 'all projects'
                  : `${s.budget.scopeType} ${s.budget.scopeId}`}
              </td>
              <td>{s.budget.period}</td>
              <td>{formatUsd(s.spentUsd)}</td>
              <td>{formatUsd(s.budget.limitUsd)}</td>
              <td className={TONE_CLASS[quotaTone(s.pct, form.warnPct)]}>{formatPctValue(s.pct)}</td>
              <td>
                {s.budget.origin === 'table' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete budget ${s.budget.scopeId ?? 'global'} ${s.budget.period}`}
                    onClick={() => remove.mutate(s.budget.id)}
                  >
                    ✕
                  </Button>
                ) : (
                  <span className="text-muted-foreground" title="From the project configuration">
                    config
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={onAddBudget} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={f('scope')}>Scope</label>
          <NativeSelect
            id={f('scope')}
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as BudgetScopeType)}
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
        </div>
        {scopeType !== 'global' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={f('scope-id')}>Scope id</label>
            <Input
              id={f('scope-id')}
              className="w-28"
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={f('period')}>Period</label>
          <NativeSelect
            id={f('period')}
            value={period}
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('limit')}>Limit (USD)</label>
          <Input
            id={f('limit')}
            className="w-24"
            type="number"
            min={1}
            value={limitUsd}
            onChange={(e) => setLimitUsd(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={upsert.isPending}>
          Add budget
        </Button>
        {upsert.isError ? (
          <span role="alert" className="text-destructive">
            Could not add the budget.
          </span>
        ) : null}
      </form>

      <ul className="text-muted-foreground">
        {(concurrency.data ?? []).map((c) => (
          <li key={c.projectId}>{`${c.projectId} ${c.owned} / ${c.max} owned sessions`}</li>
        ))}
      </ul>
    </section>
  );
}
