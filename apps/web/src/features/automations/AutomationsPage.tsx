import type { AutomationWithStats } from '@orc/api-contract';
import { useState } from 'react';
import {
  useAutomationSettings,
  useAutomationSettingsGet,
  useAutomations,
  useRunAutomation,
  useSetAutomationEnabled,
} from '@/api/queries/automations.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { formatCost, formatDateTime } from '@/lib/format.ts';
import { useProjectStore } from '@/stores/project.ts';
import { AutomationEditor } from './AutomationEditor.tsx';
import { describeTrigger, formatSuccessRate } from './editor-model.ts';
import { RunHistory } from './RunHistory.tsx';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

type Pane =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'edit'; automation: AutomationWithStats }
  | { kind: 'runs'; automation: AutomationWithStats };

function AutomationCard({
  automation: a,
  canRun,
  onRun,
  onToggle,
  onEdit,
  onHistory,
}: {
  automation: AutomationWithStats;
  canRun: boolean;
  onRun(): void;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onHistory(): void;
}) {
  return (
    <Card className="flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox aria-label={`Enable ${a.name}`} checked={a.enabled} onCheckedChange={onToggle} />
        <button type="button" className="font-medium hover:underline" onClick={onEdit}>
          {a.name}
        </button>
        <span className="ml-auto text-xs text-muted-foreground">{describeTrigger(a.trigger)}</span>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>Success {formatSuccessRate(a.stats.successRate)}</span>
        <span>{a.stats.total} runs</span>
        <span>
          {formatCost(a.stats.monthSpendUsd)} of {formatCost(a.budgetUsd)} this month
        </span>
        {a.stats.lastRunAt ? <span>Last {formatDateTime(a.stats.lastRunAt)}</span> : null}
        {a.nextRunAt ? <span>Next {formatDateTime(a.nextRunAt)}</span> : null}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!canRun} onClick={onRun}>
          Run now
        </Button>
        <Button size="sm" variant="ghost" onClick={onHistory}>
          History
        </Button>
      </div>
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
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const masterOn = settings.data?.enabled ?? false;
  const failure = error ?? settings.error ?? saveSettings.error ?? setEnabled.error ?? runNow.error;
  const close = () => setPane({ kind: 'none' });

  const detail =
    pane.kind === 'new' ? (
      <AutomationEditor projectId={projectId} onDone={close} />
    ) : pane.kind === 'edit' ? (
      <AutomationEditor
        key={pane.automation.id}
        projectId={projectId}
        initial={pane.automation}
        onDone={close}
      />
    ) : pane.kind === 'runs' ? (
      <RunHistory key={pane.automation.id} automation={pane.automation} />
    ) : (
      <SuggestionsPanel />
    );

  const list = (
    <ul className="flex flex-col gap-2 overflow-auto" aria-label="Automation list">
      {isLoading ? <li className="text-sm">Loading…</li> : null}
      {!isLoading && automations.length === 0 ? (
        <li className="text-sm text-muted-foreground">No automations yet.</li>
      ) : null}
      {automations.map((a) => (
        <li key={a.id}>
          <AutomationCard
            automation={a}
            canRun={masterOn && !runNow.isPending}
            onRun={() => runNow.mutate(a.id, { onSuccess: () => setPane({ kind: 'runs', automation: a }) })}
            onToggle={(v) => setEnabled.mutate({ id: a.id, enabled: v })}
            onEdit={() => setPane({ kind: 'edit', automation: a })}
            onHistory={() => setPane({ kind: 'runs', automation: a })}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold">Automations</h1>
        <label className="flex items-center gap-2 text-sm" htmlFor="automations-master">
          <Checkbox
            id="automations-master"
            aria-label="Automations enabled"
            checked={masterOn}
            disabled={!settings.data || saveSettings.isPending}
            onCheckedChange={(v) => saveSettings.mutate({ enabled: v })}
          />
          Automations enabled
        </label>
        {settings.data && !masterOn ? <Badge variant="warning">Off — nothing runs</Badge> : null}
        <Button className="ml-auto" onClick={() => setPane({ kind: 'new' })}>
          New automation
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        Automations never merge, deploy or touch production. Each one has a monthly budget, and every run is
        audited.
      </p>
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
    </div>
  );
}
