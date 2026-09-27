import { type Automation, AutomationInput, type AutomationTrigger } from '@orc/api-contract';

export interface EditorForm {
  id?: string;
  name: string;
  enabled: boolean;
  triggerType: AutomationTrigger['type'];
  cron: string;
  githubEvent: 'review_comment' | 'check_failed' | 'pr_merged';
  linearEvent: 'assigned' | 'labeled';
  linearLabel: string;
  slackChannel: string;
  templateId: string;
  projectId: string;
  repo: string;
  useWorktree: boolean;
  headless: boolean;
  model: string;
  timeoutMin: number;
  planApproval: boolean;
  budgetUsd: number;
}

export function emptyForm(projectId: string): EditorForm {
  return {
    name: '',
    enabled: false,
    triggerType: 'manual',
    cron: '0 9 * * 1-5',
    githubEvent: 'check_failed',
    linearEvent: 'assigned',
    linearLabel: '',
    slackChannel: '',
    templateId: '',
    projectId,
    repo: '',
    useWorktree: true,
    headless: true,
    model: '',
    timeoutMin: 30,
    planApproval: false,
    budgetUsd: 5,
  };
}

export function formFromAutomation(a: Automation): EditorForm {
  const f = emptyForm(a.action.projectId);
  const t = a.trigger;
  return {
    ...f,
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    triggerType: t.type,
    cron: t.type === 'cron' ? t.cron : f.cron,
    githubEvent: t.type === 'github' ? t.event : f.githubEvent,
    linearEvent: t.type === 'linear' ? t.event : f.linearEvent,
    linearLabel: t.type === 'linear' ? (t.label ?? '') : '',
    slackChannel: t.type === 'slack' ? t.channel : '',
    templateId: a.action.templateId,
    repo: a.action.repo ?? '',
    useWorktree: a.action.useWorktree,
    headless: a.action.headless,
    model: a.action.model ?? '',
    timeoutMin: a.action.timeoutMin,
    planApproval: a.action.planApproval,
    budgetUsd: a.budgetUsd,
  };
}

export function triggerFromForm(f: EditorForm): AutomationTrigger {
  switch (f.triggerType) {
    case 'cron':
      return { type: 'cron', cron: f.cron.trim() };
    case 'github':
      return { type: 'github', event: f.githubEvent };
    case 'linear':
      return f.linearEvent === 'labeled' && f.linearLabel.trim()
        ? { type: 'linear', event: 'labeled', label: f.linearLabel.trim() }
        : { type: 'linear', event: f.linearEvent };
    case 'slack':
      return { type: 'slack', event: 'mention', channel: f.slackChannel.trim() };
    case 'manual':
      return { type: 'manual' };
  }
}

export function buildAutomation(
  f: EditorForm,
): { ok: true; value: AutomationInput } | { ok: false; errors: string[] } {
  const candidate = {
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim(),
    enabled: f.enabled,
    trigger: triggerFromForm(f),
    action: {
      templateId: f.templateId,
      projectId: f.projectId,
      ...(f.repo.trim() ? { repo: f.repo.trim() } : {}),
      useWorktree: f.useWorktree,
      headless: f.headless,
      ...(f.model.trim() ? { model: f.model.trim() } : {}),
      timeoutMin: f.timeoutMin,
      planApproval: f.planApproval,
    },
    budgetUsd: f.budgetUsd,
  };
  const r = AutomationInput.safeParse(candidate);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`),
  };
}

export function describeTrigger(t: AutomationTrigger): string {
  switch (t.type) {
    case 'cron':
      return `Schedule ${t.cron}`;
    case 'github':
      return `GitHub: ${t.event.replace('_', ' ')}`;
    case 'linear':
      return t.event === 'assigned' ? 'Linear: assigned to me' : `Linear: label ${t.label ?? 'any'}`;
    case 'slack':
      return `Slack: mention in ${t.channel}`;
    case 'manual':
      return 'Manual only';
  }
}

export function formatSuccessRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
