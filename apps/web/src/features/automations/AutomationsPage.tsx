import type { AutomationRunRequest, AutomationTrigger, AutomationWithStats } from '@orc/api-contract';
import {
  Clock,
  GitPullRequest,
  Hand,
  MessageSquare,
  ShieldCheck,
  SquareKanban,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import {
  useAutomationSettings,
  useAutomationSettingsGet,
  useAutomations,
  useRunAutomation,
  useSetAutomationEnabled,
} from '@/api/queries/automations.ts';
import { useTemplates } from '@/api/queries/templates.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { cn } from '@/components/ui/cn.ts';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useFocusReturn } from '@/components/ui/use-focus-return.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { formatCost, formatDateTime } from '@/lib/format.ts';
import { useProjectStore } from '@/stores/project.ts';
import { AutomationEditor } from './AutomationEditor.tsx';
import { describeTrigger, formatSuccessRate } from './editor-model.ts';
import { RunHistory } from './RunHistory.tsx';
import { RunVarsDialog } from './RunVarsDialog.tsx';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

type Pane = { kind: 'none' } | { kind: 'runs'; automation: AutomationWithStats };
type Editing = { kind: 'new' } | { kind: 'edit'; automation: AutomationWithStats };

const TRIGGER_ICON: Record<AutomationTrigger['type'], typeof Clock> = {
  cron: Clock,
  github: GitPullRequest,
  linear: SquareKanban,
  slack: MessageSquare,
  manual: Hand,
};

type BudgetTone = 'ok' | 'warn' | 'over';
const TONE_CLASS: Record<BudgetTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  over: 'bg-destructive',
};

function budgetTone(spendUsd: number, budgetUsd: number): BudgetTone {
  if (budgetUsd <= 0) return 'ok';
  const pct = spendUsd / budgetUsd;
  if (pct >= 1) return 'over';
  if (pct >= 0.8) return 'warn';
  return 'ok';
}

/** A `Checkbox` styled as an on/off switch — the app has no separate `Switch` primitive. */
function ToggleSwitch({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange(v: boolean): void;
}) {
  return (
    <Checkbox
      id={id}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="relative h-5 w-9 shrink-0 rounded-full p-0 [&_svg]:hidden after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-background after:shadow-sm after:transition-transform data-checked:after:translate-x-4"
    />
  );
}

function BudgetBar({ spendUsd, budgetUsd }: { spendUsd: number; budgetUsd: number }) {
  const pct = budgetUsd > 0 ? Math.min(100, Math.round((spendUsd / budgetUsd) * 100)) : 0;
  const tone = budgetTone(spendUsd, budgetUsd);
  return (
    <div className="flex items-center gap-2">
      <span
        role="progressbar"
        aria-label="Budget used this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 flex-1 overflow-hidden rounded bg-muted"
      >
        <span className={cn('block h-full', TONE_CLASS[tone])} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('shrink-0 text-xs text-muted-foreground', tone !== 'ok' && 'text-warning')}>
        {formatCost(spendUsd)} of {formatCost(budgetUsd)} this month
      </span>
    </div>
  );
}

function AutomationCard({
  automation: a,
  canRun,
  disabledReason,
  onRun,
  onToggle,
  onEdit,
  onHistory,
}: {
  automation: AutomationWithStats;
  canRun: boolean;
  disabledReason: string | null;
  onRun(): void;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onHistory(): void;
}) {
  const Icon = TRIGGER_ICON[a.trigger.type];
  const runButton = (
    <Button size="sm" variant="outline" disabled={!canRun} onClick={onRun}>
      Run now
    </Button>
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-2">
        <ToggleSwitch label={`Enable ${a.name}`} checked={a.enabled} onCheckedChange={onToggle} />
        <CardTitle className="min-w-0 flex-1 truncate text-sm font-medium">
          <button type="button" className="hover:underline" onClick={onEdit}>
            {a.name}
          </button>
        </CardTitle>
        {!a.enabled ? <Badge variant="secondary">Off</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{describeTrigger(a.trigger)}</span>
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Success {formatSuccessRate(a.stats.successRate)}</span>
          <span>{a.stats.total} runs</span>
          {a.stats.lastRunAt ? <span>Last {formatDateTime(a.stats.lastRunAt)}</span> : null}
          {a.nextRunAt ? <span>Next {formatDateTime(a.nextRunAt)}</span> : null}
        </div>
        <BudgetBar spendUsd={a.stats.monthSpendUsd} budgetUsd={a.budgetUsd} />
      </CardContent>
      <CardFooter className="gap-2">
        {canRun ? (
          runButton
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button fires no hover/focus, so the Tooltip needs a focusable wrapper */}
              <span tabIndex={0} className="inline-flex">
                {runButton}
              </span>
            </TooltipTrigger>
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        )}
        <Button size="sm" variant="ghost" onClick={onHistory}>
          History
        </Button>
      </CardFooter>
    </Card>
  );
}

export function AutomationsPage() {
  const projectId = useProjectStore((s) => s.projectId);
  const isMobile = useIsMobile();
  const { data: automations = [], isLoading, error } = useAutomations();
  const settings = useAutomationSettingsGet();
  const saveSettings = useAutomationSettings();
  const setEnabled = useSetAutomationEnabled();
  const runNow = useRunAutomation();
  const templates = useTemplates();
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [askVars, setAskVars] = useState<AutomationWithStats | null>(null);
  const masterOn = settings.data?.enabled ?? false;
  const failure = error ?? settings.error ?? saveSettings.error ?? setEnabled.error ?? runNow.error;
  const close = () => setPane({ kind: 'none' });
  const returnFocus = useFocusReturn(editing !== null);
  const templateVars = (a: AutomationWithStats) =>
    templates.data?.find((t) => t.id === a.action.templateId)?.vars ?? [];
  const start = (a: AutomationWithStats, vars?: AutomationRunRequest['vars']) =>
    runNow.mutate(
      { id: a.id, vars },
      {
        onSuccess: () => {
          setAskVars(null);
          setPane({ kind: 'runs', automation: a });
        },
      },
    );
  const onRun = (a: AutomationWithStats) => (templateVars(a).length > 0 ? setAskVars(a) : start(a));
  const disabledReason = !masterOn
    ? 'Turn on "Automations enabled" to run this.'
    : runNow.isPending
      ? 'A run is starting — wait for it to begin.'
      : templates.isLoading
        ? 'Loading templates…'
        : null;
  const canRun = disabledReason === null;

  const detail =
    pane.kind === 'runs' ? (
      <RunHistory key={pane.automation.id} automation={pane.automation} />
    ) : (
      <SuggestionsPanel />
    );

  const empty = !isLoading && automations.length === 0;
  const list = empty ? (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Workflow aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No automations yet</EmptyTitle>
        <EmptyDescription>
          Run a template on a schedule, when a check fails on your PR, when a Linear ticket is assigned, or
          when someone mentions the bot in Slack.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={() => setEditing({ kind: 'new' })}>
          New automation
        </Button>
      </EmptyContent>
    </Empty>
  ) : (
    <ul className="flex flex-col gap-2 overflow-auto" aria-label="Automation list">
      {isLoading ? <li className="text-sm">Loading…</li> : null}
      {automations.map((a) => (
        <li key={a.id}>
          <AutomationCard
            automation={a}
            canRun={canRun}
            disabledReason={disabledReason}
            onRun={() => onRun(a)}
            onToggle={(v) => setEnabled.mutate({ id: a.id, enabled: v })}
            onEdit={() => setEditing({ kind: 'edit', automation: a })}
            onHistory={() => setPane({ kind: 'runs', automation: a })}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col gap-4 p-4">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-lg font-semibold">Automations</h1>
          <label className="flex items-center gap-2 text-sm" htmlFor="automations-master">
            <ToggleSwitch
              id="automations-master"
              label="Automations enabled"
              checked={masterOn}
              disabled={!settings.data || saveSettings.isPending}
              onCheckedChange={(v) => saveSettings.mutate({ enabled: v })}
            />
            Automations enabled
          </label>
          {settings.data && !masterOn ? <Badge variant="warning">Off — nothing runs</Badge> : null}
          {automations.length > 0 ? (
            <Button className="ml-auto" onClick={() => setEditing({ kind: 'new' })}>
              New automation
            </Button>
          ) : null}
        </header>
        <Alert>
          <ShieldCheck className="size-4" aria-hidden />
          <AlertDescription>
            Automations never merge, deploy or touch production. Each one has a monthly budget, and every run
            is audited.
          </AlertDescription>
        </Alert>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
        ) : null}
        {isMobile ? (
          pane.kind === 'none' ? (
            <div className="flex min-w-0 flex-col gap-6">
              {list}
              {detail}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              <Button size="sm" variant="ghost" className="self-start" onClick={close}>
                ← Back to list
              </Button>
              {detail}
            </div>
          )
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,1fr)_2fr] gap-4">
            {list}
            <section className="min-h-0 overflow-auto">{detail}</section>
          </div>
        )}
        {askVars ? (
          <RunVarsDialog
            name={askVars.name}
            vars={templateVars(askVars)}
            busy={runNow.isPending}
            onRun={(vars) => start(askVars, vars)}
            onClose={() => setAskVars(null)}
          />
        ) : null}
        <Sheet
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        >
          <SheetContent className="w-full sm:max-w-lg" onCloseAutoFocus={returnFocus}>
            <SheetHeader className="sr-only">
              <SheetTitle>
                {editing?.kind === 'edit' ? `Edit ${editing.automation.name}` : 'New automation'}
              </SheetTitle>
            </SheetHeader>
            {editing ? (
              <AutomationEditor
                key={editing.kind === 'edit' ? editing.automation.id : 'new'}
                projectId={projectId}
                initial={editing.kind === 'edit' ? editing.automation : undefined}
                onDone={() => setEditing(null)}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}
