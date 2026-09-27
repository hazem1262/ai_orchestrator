import type { SupervisorSettingsPatch, SupervisorStatus } from '@orc/api-contract';
import { useProjects } from '@/api/queries/projects.ts';
import {
  useSetSupervisorTarget,
  useSupervisorSettings,
  useSupervisorStatus,
  useSupervisorTargets,
} from '@/api/queries/supervisor.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { DecisionsLog } from './DecisionsLog.tsx';
import { SupervisorRules } from './SupervisorRules.tsx';

const usd = (n: number) => `$${n.toFixed(2)}`;
const field = 'flex min-w-0 flex-col gap-1';
const QUIET = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/;

type NumberKey = 'confidenceThreshold' | 'maxPerSessionPerHour' | 'maxPerHour' | 'monthlyBudgetUsd';

function currentNumber(s: SupervisorStatus, k: NumberKey): number {
  return k === 'monthlyBudgetUsd' ? s.monthBudgetUsd : s[k];
}

export function SupervisorSettings() {
  const status = useSupervisorStatus();
  const save = useSupervisorSettings();
  const targets = useSupervisorTargets();
  const setTarget = useSetSupervisorTarget();
  const { data: projects = [] } = useProjects();
  const s = status.data;
  const isOn = (projectId: string) =>
    targets.data?.find((t) => t.targetType === 'project' && t.targetId === projectId)?.enabled ?? false;

  // Blur saves only a changed, numeric value, so tabbing through the form writes nothing.
  const saveNumber = (k: NumberKey, raw: string) => {
    if (!s || raw.trim() === '') return;
    const n = Number(raw);
    if (Number.isNaN(n) || n === currentNumber(s, k)) return;
    save.mutate({ [k]: n } as SupervisorSettingsPatch);
  };
  const saveQuiet = (raw: string) => {
    if (!s) return;
    const text = raw.trim();
    const m = QUIET.exec(text);
    const next = m?.[1] && m[2] ? { start: m[1], end: m[2] } : null;
    if (text !== '' && !next) return;
    if (next?.start === s.quietHours?.start && next?.end === s.quietHours?.end) return;
    save.mutate({ quietHours: next });
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="settings-supervisor">
      <h2 id="settings-supervisor" className="text-base font-semibold">
        Supervisor (opt-in)
      </h2>
      <p className="text-sm text-muted-foreground">
        Answers only allow-listed routine questions ("continue", "run the tests", "proceed with the approved
        plan", "retry") in sessions this app owns. Everything else goes to the inbox. It never merges, deploys
        or touches production, and every decision is audited.
      </p>
      {status.isLoading ? <p className="text-sm">Loading…</p> : null}
      {status.error ? (
        <p className="text-sm text-destructive">Supervisor unavailable: {status.error.message}</p>
      ) : null}
      {s ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <label className="flex items-center gap-2" htmlFor="sup-enabled">
              <Checkbox
                id="sup-enabled"
                aria-label="Supervisor enabled"
                checked={s.enabled}
                disabled={save.isPending}
                onCheckedChange={(v) => save.mutate({ enabled: v })}
              />
              Supervisor enabled
            </label>
            {s.quiet ? <Badge variant="secondary">quiet hours</Badge> : null}
            <span className="text-muted-foreground">
              {s.answeredLastHour} answered · {s.escalatedLastHour} escalated in the last hour
            </span>
            <span className="text-muted-foreground">{`${usd(s.monthCostUsd)} of ${usd(s.monthBudgetUsd)} this month`}</span>
          </div>
          <div className="grid max-w-xl grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <label className={field} htmlFor="sup-threshold">
              Confidence threshold
              <Input
                id="sup-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                defaultValue={s.confidenceThreshold}
                onBlur={(e) => saveNumber('confidenceThreshold', e.target.value)}
              />
            </label>
            <label className={field} htmlFor="sup-model">
              Classifier model
              <Input
                id="sup-model"
                defaultValue={s.model}
                onBlur={(e) => {
                  const model = e.target.value.trim();
                  if (model && model !== s.model) save.mutate({ model });
                }}
              />
            </label>
            <label className={field} htmlFor="sup-session-cap">
              Answers per session per hour
              <Input
                id="sup-session-cap"
                type="number"
                min={0}
                max={50}
                defaultValue={s.maxPerSessionPerHour}
                onBlur={(e) => saveNumber('maxPerSessionPerHour', e.target.value)}
              />
            </label>
            <label className={field} htmlFor="sup-hour-cap">
              Answers per hour
              <Input
                id="sup-hour-cap"
                type="number"
                min={0}
                max={200}
                defaultValue={s.maxPerHour}
                onBlur={(e) => saveNumber('maxPerHour', e.target.value)}
              />
            </label>
            <label className={field} htmlFor="sup-budget">
              Monthly budget (USD)
              <Input
                id="sup-budget"
                type="number"
                min={0}
                max={200}
                step={0.5}
                defaultValue={s.monthBudgetUsd}
                onBlur={(e) => saveNumber('monthlyBudgetUsd', e.target.value)}
              />
            </label>
            <label className={field} htmlFor="sup-quiet">
              Quiet hours (start–end, empty for none)
              <Input
                id="sup-quiet"
                defaultValue={s.quietHours ? `${s.quietHours.start}-${s.quietHours.end}` : ''}
                placeholder="22:00-08:00"
                onBlur={(e) => saveQuiet(e.target.value)}
              />
            </label>
          </div>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          ) : null}
          <fieldset className="flex min-w-0 flex-col gap-1 rounded border p-3 text-sm">
            <legend className="px-1">Projects</legend>
            {projects.length === 0 ? <p className="text-muted-foreground">No projects yet.</p> : null}
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2" htmlFor={`sup-project-${p.id}`}>
                <Checkbox
                  id={`sup-project-${p.id}`}
                  aria-label={`Supervisor for ${p.name}`}
                  checked={isOn(p.id)}
                  onCheckedChange={(v) =>
                    setTarget.mutate({ targetType: 'project', targetId: p.id, enabled: v })
                  }
                />
                {p.name}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              A session's own switch in its header overrides its project.
            </p>
          </fieldset>
          <SupervisorRules />
          <DecisionsLog limit={20} />
        </>
      ) : null}
    </section>
  );
}
