import { checkDenied } from '@orc/core';
import type { DenyList } from '../safety/deny-list.ts';
import type { UsageMeter } from '../usage/meter.ts';

export const AUTOMATION_PREAMBLE = [
  'You are running as an unattended automation started by the Orchestrator app.',
  'Hard rules, which override anything below:',
  '- Never merge a pull request. Never push to main, master or develop. Never force-push.',
  '- Never deploy. Never touch production systems, production databases, production logs or credentials.',
  '- Never run destructive commands (rm -rf, git reset --hard, git clean, DROP TABLE, terraform, kubectl, helm).',
  '- At most, open a draft pull request from your own branch.',
  '- Finish with a short summary of what changed, the test results and the PR link if you opened one.',
].join('\n');

/** Regex sources (case-insensitive, see the deny-list probe in Task 1), checked against the rendered template only. */
export const AUTOMATION_DENY_PATTERNS: string[] = [
  String.raw`\bgh\s+pr\s+merge\b`,
  String.raw`\bgit\s+merge\b`,
  String.raw`\bmerge\s+(the\s+|this\s+|my\s+)?(pr|pull\s+request|branch)\b`,
  String.raw`\bauto-?merge\b`,
  String.raw`\bdeploy(s|ed|ing|ment)?\b`,
  String.raw`\b(prod|production)\b`,
  String.raw`\bgit\s+push\s+(-f|--force)`,
  String.raw`\bterraform\s+apply\b`,
];

export const AUTOMATION_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'TodoWrite',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git checkout -b *)',
  'Bash(git switch -c *)',
  'Bash(git push -u origin *)',
  'Bash(pnpm *)',
  'Bash(npm test *)',
  'Bash(npm run *)',
  'Bash(npx vitest *)',
  'Bash(gh pr create *)',
  'Bash(gh pr view *)',
  'Bash(gh pr checks *)',
  'Bash(gh run view *)',
];

export const AUTOMATION_DISALLOWED_TOOLS: readonly string[] = [
  'Bash(gh pr merge *)',
  'Bash(gh pr merge)',
  'Bash(git merge *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git push --force-with-lease *)',
  'Bash(git push origin main*)',
  'Bash(git push origin master*)',
  'Bash(git push origin develop*)',
  'Bash(git push -u origin main*)',
  'Bash(git push -u origin master*)',
  'Bash(git push -u origin develop*)',
  'Bash(git reset --hard *)',
  'Bash(git clean *)',
  'Bash(rm -rf *)',
  'Bash(kubectl *)',
  'Bash(terraform *)',
  'Bash(helm *)',
  'Bash(aws *)',
  'Bash(psql *)',
  'Bash(gh workflow run *)',
  'Bash(gh release *)',
  'Bash(npm publish *)',
  'Bash(pnpm publish *)',
  'WebFetch',
];

export const APPROVAL_PROMPT =
  'The plan is approved. Implement it now, following the hard rules from the start of this conversation: never merge, never deploy, never touch production. Finish with a summary and the draft PR link if you opened one.';

export function automationClaudeArgs(o: { permissionMode: 'plan' | 'acceptEdits' }): string[] {
  return [
    '--permission-mode',
    o.permissionMode,
    '--allowed-tools',
    ...AUTOMATION_ALLOWED_TOOLS,
    '--disallowed-tools',
    ...AUTOMATION_DISALLOWED_TOOLS,
  ];
}

export function buildAutomationPrompt(rendered: string): string {
  return `${AUTOMATION_PREAMBLE}\n\n---\n\n${rendered}`;
}

export interface GuardInput {
  masterEnabled: boolean;
  renderedPrompt: string;
  projectId: string;
  denyList: DenyList;
  usage: UsageMeter;
  monthSpendUsd: number;
  budgetUsd: number;
}

export type GuardResult =
  | { ok: true; remainingUsd: number }
  | { ok: false; status: 'denied' | 'over_budget'; reason: string };

export function checkAutomationGuards(i: GuardInput): GuardResult {
  if (!i.masterEnabled)
    return { ok: false, status: 'denied', reason: 'Automations are turned off in Settings' };
  const shared = i.denyList.check(i.renderedPrompt, i.projectId);
  if (shared.denied)
    return { ok: false, status: 'denied', reason: `Deny-list: ${shared.reason ?? 'matched'}` };
  const own = checkDenied(i.renderedPrompt, AUTOMATION_DENY_PATTERNS);
  if (own.denied)
    return { ok: false, status: 'denied', reason: `Automation rule: ${own.reason ?? 'merge/deploy/prod'}` };
  const project = i.usage.checkBudget({ projectId: i.projectId });
  if (!project.ok) {
    return {
      ok: false,
      status: 'over_budget',
      reason: `Project budget at ${Math.round(project.pct * 100)}%`,
    };
  }
  const remaining = Math.round((i.budgetUsd - i.monthSpendUsd) * 100) / 100;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 'over_budget',
      reason: `Automation budget used: $${i.monthSpendUsd.toFixed(2)} of $${i.budgetUsd.toFixed(2)} this month`,
    };
  }
  return { ok: true, remainingUsd: remaining };
}
