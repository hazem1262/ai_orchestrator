import { ALL_PROJECTS, type Automation } from '@orc/api-contract';
import { type FormEvent, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { automationKeys, useSaveAutomation } from '@/api/queries/automations.ts';
import { useProjects } from '@/api/queries/projects.ts';
import { useTemplates } from '@/api/queries/templates.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { DEFAULT_PROJECT_ID } from '@/stores/project.ts';
import { ConfirmActionDialog } from './ConfirmActionDialog.tsx';
import { buildAutomation, type EditorForm, emptyForm, formFromAutomation } from './editor-model.ts';

const field = 'flex flex-col gap-1 text-sm';

export function AutomationEditor({
  projectId,
  initial,
  onDone,
}: {
  projectId: string;
  initial?: Automation;
  onDone(): void;
}) {
  const { data: projects = [] } = useProjects();
  const startProject = projectId === ALL_PROJECTS ? DEFAULT_PROJECT_ID : projectId;
  const [form, setForm] = useState<EditorForm>(() =>
    initial ? formFromAutomation(initial) : emptyForm(startProject),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const templates = useTemplates(form.projectId);
  const save = useSaveAutomation();
  const remove = useConfirmedMutation(
    (id: string, confirm: boolean) => getApiClient().automationsDelete(id, confirm),
    { invalidate: [automationKeys.list], onSuccess: () => onDone() },
  );
  const set = <K extends keyof EditorForm>(k: K, v: EditorForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildAutomation(form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors([]);
    save.mutate(r.value, { onSuccess: onDone });
  };

  return (
    <>
      <form aria-label="Automation editor" onSubmit={submit} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <h2 className="text-base font-semibold">{initial ? `Edit ${initial.name}` : 'New automation'}</h2>
        {!initial ? (
          <p className="text-xs text-muted-foreground">
            New automations start turned off. Turn one on from the list once you are happy with it.
          </p>
        ) : null}
        <label className={field} htmlFor="auto-name">
          Name
          <Input id="auto-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={field} htmlFor="auto-project">
            Project
            <NativeSelect
              id="auto-project"
              value={form.projectId}
              onChange={(e) => set('projectId', e.target.value)}
            >
              {projects.some((p) => p.id === form.projectId) ? null : (
                <option value={form.projectId}>{form.projectId}</option>
              )}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className={field} htmlFor="auto-template">
            Template
            <NativeSelect
              id="auto-template"
              value={form.templateId}
              onChange={(e) => set('templateId', e.target.value)}
            >
              <option value="">Choose a template…</option>
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <label className={field} htmlFor="auto-trigger">
          Trigger
          <NativeSelect
            id="auto-trigger"
            value={form.triggerType}
            onChange={(e) => set('triggerType', e.target.value as EditorForm['triggerType'])}
          >
            <option value="manual">Manual only</option>
            <option value="cron">Schedule (cron)</option>
            <option value="github">GitHub event on my PRs</option>
            <option value="linear">Linear event</option>
            <option value="slack">Slack mention</option>
          </NativeSelect>
        </label>
        {form.triggerType === 'cron' ? (
          <label className={field} htmlFor="auto-cron">
            Cron
            <Input
              id="auto-cron"
              value={form.cron}
              onChange={(e) => set('cron', e.target.value)}
              placeholder="0 9 * * 1-5"
            />
          </label>
        ) : null}
        {form.triggerType === 'github' ? (
          <div className={field}>
            <label className={field} htmlFor="auto-gh">
              GitHub event
              <NativeSelect
                id="auto-gh"
                value={form.githubEvent}
                onChange={(e) => set('githubEvent', e.target.value as EditorForm['githubEvent'])}
              >
                <option value="check_failed">Check failed</option>
                <option value="review_comment">Changes requested</option>
                <option value="pr_merged">PR merged (backmerge suggestion)</option>
              </NativeSelect>
            </label>
            <span className="text-xs text-muted-foreground">
              Only PRs from repos listed in this project's settings start this automation.
            </span>
          </div>
        ) : null}
        {form.triggerType === 'linear' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={field} htmlFor="auto-linear">
              Linear event
              <NativeSelect
                id="auto-linear"
                value={form.linearEvent}
                onChange={(e) => set('linearEvent', e.target.value as EditorForm['linearEvent'])}
              >
                <option value="assigned">Assigned to me</option>
                <option value="labeled">Label added</option>
              </NativeSelect>
            </label>
            {form.linearEvent === 'labeled' ? (
              <label className={field} htmlFor="auto-label">
                Label
                <Input
                  id="auto-label"
                  value={form.linearLabel}
                  onChange={(e) => set('linearLabel', e.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}
        {form.triggerType === 'slack' ? (
          <label className={field} htmlFor="auto-slack">
            Slack channel ID
            <Input
              id="auto-slack"
              value={form.slackChannel}
              onChange={(e) => set('slackChannel', e.target.value)}
              placeholder="C0123456"
            />
          </label>
        ) : null}
        <fieldset className="grid grid-cols-1 gap-2 rounded border p-3 text-sm sm:grid-cols-2">
          <legend className="px-1">Run</legend>
          <label className="flex items-center gap-2" htmlFor="auto-worktree">
            <Checkbox
              id="auto-worktree"
              aria-label="Use a new worktree"
              checked={form.useWorktree}
              onCheckedChange={(v) => set('useWorktree', v)}
            />
            Use a new worktree
          </label>
          <label className="flex items-center gap-2" htmlFor="auto-headless">
            <Checkbox
              id="auto-headless"
              aria-label="Headless"
              checked={form.headless}
              onCheckedChange={(v) => set('headless', v)}
            />
            Headless (claude -p)
          </label>
          <label className="flex items-center gap-2" htmlFor="auto-plan">
            <Checkbox
              id="auto-plan"
              aria-label="Plan approval first"
              checked={form.planApproval}
              onCheckedChange={(v) => set('planApproval', v)}
            />
            Plan approval first
          </label>
          <label className={field} htmlFor="auto-model">
            Model (optional)
            <Input
              id="auto-model"
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
              placeholder="claude-sonnet-5"
            />
          </label>
          <label className={field} htmlFor="auto-repo">
            Repo path (optional)
            <Input id="auto-repo" value={form.repo} onChange={(e) => set('repo', e.target.value)} />
          </label>
          <label className={field} htmlFor="auto-timeout">
            Timeout (minutes)
            <Input
              id="auto-timeout"
              type="number"
              min={1}
              max={240}
              value={form.timeoutMin}
              onChange={(e) => set('timeoutMin', Number(e.target.value))}
            />
          </label>
          <label className={field} htmlFor="auto-budget">
            Monthly budget (USD)
            <Input
              id="auto-budget"
              type="number"
              min={0.5}
              step={0.5}
              value={form.budgetUsd}
              onChange={(e) => set('budgetUsd', Number(e.target.value))}
            />
          </label>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Runs use a restricted tool set: no merges, no force-push, no deploy, kubectl, terraform or
          production access. The shared deny-list is checked before every run.
        </p>
        {errors.length > 0 ? (
          <ul role="alert" className="text-sm text-destructive">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {save.error || remove.error ? (
          <p role="alert" className="text-sm text-destructive">
            {(save.error ?? remove.error)?.message}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {initial ? (
            <Button
              type="button"
              variant="outline"
              className="ml-auto text-destructive"
              disabled={remove.busy}
              onClick={() => void remove.run(initial.id)}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmActionDialog
        request={remove.pending}
        busy={remove.busy}
        title="Delete automation?"
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove.confirm()}
        onCancel={remove.cancel}
      />
    </>
  );
}
