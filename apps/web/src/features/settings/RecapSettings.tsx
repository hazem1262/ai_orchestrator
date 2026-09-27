import type { RecapsConfig } from '@orc/api-contract';
import { DEFAULT_RECAP_PROMPT } from '@orc/core/browser';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useSettings, useUpdateSettings } from '@/api/queries/settings.ts';
import { useRecapSpend } from '@/api/queries/work.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { formatUsd } from '@/features/limits/format.ts';
import { NumberInput } from './NumberInput.tsx';

const TRIGGERS: Array<RecapsConfig['trigger']> = ['manual', 'on_idle', 'daily'];
const ENGINES: Array<RecapsConfig['engine']> = ['claude-cli', 'anthropic-api'];
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function RecapSettings() {
  const id = useId();
  const q = useSettings();
  const save = useUpdateSettings();
  const spend = useRecapSpend();
  const [form, setForm] = useState<RecapsConfig | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data.recaps);
  }, [q.data]);

  if (!form) {
    return (
      <section aria-label="LLM recaps" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">LLM recaps</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }
  const set = <K extends keyof RecapsConfig>(key: K, value: RecapsConfig[K]) =>
    setForm({ ...form, [key]: value });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (form) save.mutate({ recaps: form });
  }

  const f = (name: string) => `${id}-${name}`;
  return (
    <section aria-label="LLM recaps" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">LLM recaps</h2>
      <p className="text-sm text-muted-foreground">
        Recaps send a redacted digest (prompts, assistant text, tool names, deliverables and test results) to
        the engine below. Tool output is never sent.
        {spend.data
          ? ` Spent ${formatUsd(spend.data.spentUsd)} of ${formatUsd(spend.data.budgetUsd)} this month.`
          : ''}
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2">
          <Checkbox id={f('enabled')} checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
          <label htmlFor={f('enabled')}>Enable automatic recaps</label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={f('trigger')}>Trigger</label>
            <NativeSelect
              id={f('trigger')}
              value={form.trigger}
              onChange={(e) => set('trigger', e.target.value as RecapsConfig['trigger'])}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('engine')}>Engine</label>
            <NativeSelect
              id={f('engine')}
              value={form.engine}
              onChange={(e) => set('engine', e.target.value as RecapsConfig['engine'])}
            >
              {ENGINES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('idle')}>Idle minutes</label>
            <NumberInput
              id={f('idle')}
              className="w-20"
              min={1}
              value={form.idleMinutes}
              onValue={(n) => {
                if (n !== null) set('idleMinutes', n);
              }}
            />
          </div>
        </div>
        {form.engine === 'anthropic-api' ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2">
            The API engine needs ANTHROPIC_API_KEY in the daemon's environment. The claude-cli engine reuses
            your Claude login.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={f('auto-model')}>Automatic model</label>
            <Input
              id={f('auto-model')}
              value={form.autoModel}
              onChange={(e) => set('autoModel', e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('demand-model')}>On-demand model</label>
            <Input
              id={f('demand-model')}
              value={form.onDemandModel}
              onChange={(e) => set('onDemandModel', e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('budget')}>Monthly budget (USD)</label>
            <NumberInput
              id={f('budget')}
              className="w-24"
              min={0}
              step="1"
              value={form.monthlyBudgetUsd}
              onValue={(n) => {
                if (n !== null) set('monthlyBudgetUsd', n);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('max-tokens')}>Max input tokens</label>
            <NumberInput
              id={f('max-tokens')}
              className="w-28"
              min={1000}
              value={form.maxInputTokens}
              onValue={(n) => {
                if (n !== null) set('maxInputTokens', n);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('min-prompts')}>Skip under N prompts</label>
            <NumberInput
              id={f('min-prompts')}
              className="w-20"
              min={0}
              value={form.minPrompts}
              onValue={(n) => {
                if (n !== null) set('minPrompts', n);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('language')}>Output language</label>
            <Input
              id={f('language')}
              className="w-20"
              value={form.language}
              onChange={(e) => set('language', e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={f('exclude')}>Excluded projects</label>
            <Input
              id={f('exclude')}
              value={form.excludeProjectIds.join(', ')}
              onChange={(e) => set('excludeProjectIds', csv(e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={f('daily')}>Daily recap projects</label>
            <Input
              id={f('daily')}
              value={form.dailyProjectIds.join(', ')}
              onChange={(e) => set('dailyProjectIds', csv(e.target.value))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={f('prompt')}>Prompt template</label>
          <textarea
            id={f('prompt')}
            className="h-40 rounded-md border bg-background p-2 font-mono text-xs"
            placeholder={DEFAULT_RECAP_PROMPT}
            value={form.promptTemplate ?? ''}
            onChange={(e) => set('promptTemplate', e.target.value.length > 0 ? e.target.value : null)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            Save recap settings
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => set('promptTemplate', null)}>
            Reset to the default prompt
          </Button>
          {save.isError ? (
            <span role="alert" className="text-destructive">
              Could not save.
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
