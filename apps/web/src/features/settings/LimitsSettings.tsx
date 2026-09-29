import type { LimitsConfig } from '@orc/api-contract';
import type { BudgetPeriod, BudgetScopeType } from '@orc/core';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useSettings, useUpdateSettings } from '@/api/queries/settings.ts';
import { useBudgets, useConcurrency, useDeleteBudget, useUpsertBudget } from '@/api/queries/usage.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx';
import { formatPctValue, formatUsd, quotaTone } from '@/features/limits/format.ts';
import { NumberInput } from './NumberInput.tsx';
import { SettingsCard } from './SettingsCard.tsx';

const SCOPES: BudgetScopeType[] = ['global', 'project', 'ticket'];
const PERIODS: BudgetPeriod[] = ['daily', 'weekly', 'monthly'];
const TONE_CLASS = { ok: '', warn: 'text-warning', over: 'text-destructive' } as const;
const TITLE = 'Limits & budgets';
const field = 'flex min-w-0 flex-col gap-2';

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
      <SettingsCard label={TITLE} title={TITLE}>
        <p className="text-muted-foreground">Loading…</p>
      </SettingsCard>
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
  const budgetRows = budgets.data ?? [];
  return (
    <SettingsCard
      label={TITLE}
      title={TITLE}
      description={`Quota figures are ${
        form.quotaSource === 'estimate'
          ? 'estimated from transcripts (like ccusage)'
          : 'read from the official statusline source'
      }. Set your plan's token limits to turn the bars into percentages.`}
    >
      <form onSubmit={onSaveLimits} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={field}>
            <Label htmlFor={f('block')}>5-hour token limit</Label>
            <NumberInput
              id={f('block')}
              className="font-mono"
              min={0}
              value={form.blockTokenLimit}
              onValue={(n) =>
                setForm({ ...form, blockTokenLimit: n === null ? null : Math.trunc(n) || null })
              }
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('week')}>7-day token limit</Label>
            <NumberInput
              id={f('week')}
              className="font-mono"
              min={0}
              value={form.weekTokenLimit}
              onValue={(n) => setForm({ ...form, weekTokenLimit: n === null ? null : Math.trunc(n) || null })}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('warn')}>Warn at</Label>
            <NumberInput
              id={f('warn')}
              className="font-mono"
              min={0}
              max={1}
              step="0.05"
              value={form.warnPct}
              onValue={(n) => {
                if (n !== null) setForm({ ...form, warnPct: n });
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('ctx-warn')}>Context warning at</Label>
            <NumberInput
              id={f('ctx-warn')}
              className="font-mono"
              min={0}
              max={1}
              step="0.05"
              value={form.contextWarnFill}
              onValue={(n) => {
                if (n !== null) setForm({ ...form, contextWarnFill: n });
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('ctx-default')}>Default context window</Label>
            <NumberInput
              id={f('ctx-default')}
              className="font-mono"
              min={1000}
              value={form.defaultContextWindow}
              onValue={(n) => {
                if (n !== null) setForm({ ...form, defaultContextWindow: n });
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            Save limits
          </Button>
          {save.isError ? (
            <span role="alert" className="text-destructive">
              Could not save.
            </span>
          ) : null}
        </div>
      </form>

      <Separator />

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">Budgets</h3>
        <Table>
          <TableCaption className="mt-2 text-left">
            Budgets from a project's configuration are edited in that project's settings.
          </TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-muted-foreground">Scope</TableHead>
              <TableHead className="text-muted-foreground">Period</TableHead>
              <TableHead className="text-right text-muted-foreground">Spent</TableHead>
              <TableHead className="text-right text-muted-foreground">Limit</TableHead>
              <TableHead className="text-right text-muted-foreground">Used</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budgetRows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="text-muted-foreground">
                  No budgets yet.
                </TableCell>
              </TableRow>
            ) : null}
            {budgetRows.map((s) => (
              <TableRow key={s.budget.id}>
                <TableCell>
                  {s.budget.scopeType === 'global'
                    ? 'all projects'
                    : `${s.budget.scopeType} ${s.budget.scopeId}`}
                </TableCell>
                <TableCell>{s.budget.period}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatUsd(s.spentUsd)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatUsd(s.budget.limitUsd)}
                </TableCell>
                <TableCell
                  className={`text-right font-mono tabular-nums ${TONE_CLASS[quotaTone(s.pct, form.warnPct)]}`}
                >
                  {formatPctValue(s.pct)}
                </TableCell>
                <TableCell className="text-right">
                  {s.budget.origin === 'table' ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete budget ${s.budget.scopeId ?? 'global'} ${s.budget.period}`}
                      onClick={() => remove.mutate(s.budget.id)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" title="From the project configuration">
                      config
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <form onSubmit={onAddBudget} className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
          <div className={field}>
            <Label htmlFor={f('scope')}>Scope</Label>
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
            <div className={field}>
              <Label htmlFor={f('scope-id')}>Scope id</Label>
              <Input
                id={f('scope-id')}
                className="sm:w-32"
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
              />
            </div>
          ) : null}
          <div className={field}>
            <Label htmlFor={f('period')}>Period</Label>
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
          <div className={field}>
            <Label htmlFor={f('limit')}>Limit (USD)</Label>
            <Input
              id={f('limit')}
              className="font-mono sm:w-28"
              type="number"
              min={1}
              value={limitUsd}
              onChange={(e) => setLimitUsd(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={upsert.isPending}>
            Add budget
          </Button>
          {upsert.isError ? (
            <span role="alert" className="col-span-2 text-destructive">
              Could not add the budget.
            </span>
          ) : null}
        </form>
      </div>

      {(concurrency.data ?? []).length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">Owned sessions</h3>
            <ul className="text-muted-foreground">
              {(concurrency.data ?? []).map((c) => (
                <li key={c.projectId}>{`${c.projectId} ${c.owned} / ${c.max} owned sessions`}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </SettingsCard>
  );
}
