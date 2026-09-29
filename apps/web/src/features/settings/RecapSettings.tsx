import type { RecapsConfig } from '@orc/api-contract';
import { DEFAULT_RECAP_PROMPT } from '@orc/core/browser';
import { TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useSettings, useUpdateSettings } from '@/api/queries/settings.ts';
import { useRecapSpend } from '@/api/queries/work.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { formatUsd } from '@/features/limits/format.ts';
import { NumberInput } from './NumberInput.tsx';
import { SettingsCard } from './SettingsCard.tsx';

const TRIGGERS: Array<RecapsConfig['trigger']> = ['manual', 'on_idle', 'daily'];
const ENGINES: Array<{ value: RecapsConfig['engine']; label: string; hint: string }> = [
  { value: 'claude-cli', label: 'Claude CLI', hint: 'Reuses your Claude login.' },
  { value: 'anthropic-api', label: 'Anthropic API', hint: 'Billed to an Anthropic API key.' },
];
const isEngine = (v: string): v is RecapsConfig['engine'] => ENGINES.some((e) => e.value === v);
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const field = 'flex min-w-0 flex-col gap-2';
const TITLE = 'LLM recaps';
const DESCRIPTION =
  'Recaps send a redacted digest (prompts, assistant text, tool names, deliverables and test results) to the engine below. Tool output is never sent.';

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
      <SettingsCard label={TITLE} title={TITLE} description={DESCRIPTION}>
        <p className="text-muted-foreground">Loading…</p>
      </SettingsCard>
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
    <SettingsCard
      label={TITLE}
      title={TITLE}
      description={`${DESCRIPTION}${
        spend.data
          ? ` Spent ${formatUsd(spend.data.spentUsd)} of ${formatUsd(spend.data.budgetUsd)} this month.`
          : ''
      }`}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <Checkbox id={f('enabled')} checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
          <Label htmlFor={f('enabled')}>Enable automatic recaps</Label>
        </div>
        <Separator />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label htmlFor={f('trigger')}>Trigger</Label>
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
          <div className={field}>
            <Label htmlFor={f('idle')}>Idle minutes</Label>
            <NumberInput
              id={f('idle')}
              min={1}
              value={form.idleMinutes}
              onValue={(n) => {
                if (n !== null) set('idleMinutes', n);
              }}
            />
          </div>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend id={f('engine')} className="mb-2 text-sm font-medium">
            Engine
          </legend>
          <RadioGroup
            aria-labelledby={f('engine')}
            value={form.engine}
            onValueChange={(v) => {
              if (isEngine(v)) set('engine', v);
            }}
          >
            {ENGINES.map((e) => (
              <div key={e.value} className="flex items-start gap-2">
                <RadioGroupItem id={f(`engine-${e.value}`)} value={e.value} className="mt-0.5" />
                <div className="flex flex-col gap-1">
                  <Label htmlFor={f(`engine-${e.value}`)} className="font-normal">
                    {e.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">{e.hint}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          {form.engine === 'anthropic-api' ? (
            <Alert role="status" className="border-warning/40 bg-warning/10">
              <TriangleAlert aria-hidden className="text-warning" />
              <AlertDescription className="text-pretty text-foreground">
                The API engine needs ANTHROPIC_API_KEY in the daemon's environment. The claude-cli engine
                reuses your Claude login.
              </AlertDescription>
            </Alert>
          ) : null}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label htmlFor={f('auto-model')}>Automatic model</Label>
            <Input
              id={f('auto-model')}
              className="font-mono"
              value={form.autoModel}
              onChange={(e) => set('autoModel', e.target.value)}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('demand-model')}>On-demand model</Label>
            <Input
              id={f('demand-model')}
              className="font-mono"
              value={form.onDemandModel}
              onChange={(e) => set('onDemandModel', e.target.value)}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('budget')}>Monthly budget (USD)</Label>
            <NumberInput
              id={f('budget')}
              min={0}
              step="1"
              value={form.monthlyBudgetUsd}
              onValue={(n) => {
                if (n !== null) set('monthlyBudgetUsd', n);
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('max-tokens')}>Max input tokens</Label>
            <NumberInput
              id={f('max-tokens')}
              min={1000}
              value={form.maxInputTokens}
              onValue={(n) => {
                if (n !== null) set('maxInputTokens', n);
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('min-prompts')}>Skip under N prompts</Label>
            <NumberInput
              id={f('min-prompts')}
              min={0}
              value={form.minPrompts}
              onValue={(n) => {
                if (n !== null) set('minPrompts', n);
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('language')}>Output language</Label>
            <Input
              id={f('language')}
              value={form.language}
              onChange={(e) => set('language', e.target.value)}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('exclude')}>Excluded projects</Label>
            <Input
              id={f('exclude')}
              value={form.excludeProjectIds.join(', ')}
              onChange={(e) => set('excludeProjectIds', csv(e.target.value))}
            />
          </div>
          <div className={field}>
            <Label htmlFor={f('daily')}>Daily recap projects</Label>
            <Input
              id={f('daily')}
              value={form.dailyProjectIds.join(', ')}
              onChange={(e) => set('dailyProjectIds', csv(e.target.value))}
            />
          </div>
        </div>
        <div className={field}>
          <Label htmlFor={f('prompt')}>Prompt template</Label>
          <Textarea
            id={f('prompt')}
            className="h-40 font-mono text-xs md:text-xs field-sizing-fixed"
            placeholder={DEFAULT_RECAP_PROMPT}
            value={form.promptTemplate ?? ''}
            onChange={(e) => set('promptTemplate', e.target.value.length > 0 ? e.target.value : null)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
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
    </SettingsCard>
  );
}
