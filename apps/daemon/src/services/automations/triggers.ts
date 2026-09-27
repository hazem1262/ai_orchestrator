import { basename } from 'node:path';
import type { Automation, ProjectConfig } from '@orc/api-contract';
import { compileTicketRegex, DEFAULT_TICKET_REGEX, extractTickets, type PrStatus, redact } from '@orc/core';
import type { LinearIssue } from '../../connectors/linear/linear.ts';

export type TriggerEvent =
  | {
      type: 'github';
      event: 'review_comment' | 'check_failed' | 'pr_merged';
      key: string;
      repo: string;
      vars: Record<string, string>;
    }
  | {
      type: 'linear';
      event: 'assigned' | 'labeled';
      label: string | null;
      key: string;
      vars: Record<string, string>;
    }
  | { type: 'slack'; event: 'mention'; channel: string; key: string; vars: Record<string, string> };

const DEFAULT_RE = compileTicketRegex(DEFAULT_TICKET_REGEX);

/** GitHub events fire only on a transition; a PR seen for the first time (`before === null`) never fires. */
export function githubEventsFromPrChange(before: PrStatus | null, after: PrStatus): TriggerEvent[] {
  if (before === null) return [];
  const ref = `${after.pr.repo}#${after.pr.number}`;
  const ticket = extractTickets(`${after.title} ${after.headRef ?? ''}`, DEFAULT_RE)[0];
  const vars: Record<string, string> = { prUrl: after.pr.url, ...(ticket ? { ticket } : {}) };
  const repo = after.pr.repo;
  const out: TriggerEvent[] = [];
  if (
    after.state === 'open' &&
    after.review === 'changes_requested' &&
    before.review !== 'changes_requested'
  ) {
    out.push({
      type: 'github',
      event: 'review_comment',
      repo,
      key: `github:${ref}:review_comment:${after.updatedAt}`,
      vars,
    });
  }
  if (after.state === 'open' && after.checks === 'failure' && before.checks !== 'failure') {
    out.push({
      type: 'github',
      event: 'check_failed',
      repo,
      key: `github:${ref}:check_failed:${after.updatedAt}`,
      vars: { ...vars, check: after.failedChecks.join(', ') || 'failing checks' },
    });
  }
  if (after.state === 'merged' && before.state !== 'merged') {
    out.push({ type: 'github', event: 'pr_merged', repo, key: `github:${ref}:pr_merged`, vars });
  }
  return out;
}

export function linearEventsFromIssueChange(before: LinearIssue | null, after: LinearIssue): TriggerEvent[] {
  const vars: Record<string, string> = { ticket: after.identifier, ticketUrl: after.url };
  const out: TriggerEvent[] = [];
  if (before === null) {
    out.push({
      type: 'linear',
      event: 'assigned',
      label: null,
      key: `linear:${after.identifier}:assigned`,
      vars,
    });
  }
  const had = new Set((before?.labels ?? []).map((l) => l.toLowerCase()));
  for (const label of after.labels) {
    if (had.has(label.toLowerCase())) continue;
    out.push({
      type: 'linear',
      event: 'labeled',
      label,
      key: `linear:${after.identifier}:label:${label}`,
      vars: { ...vars, label },
    });
  }
  return out;
}

export function slackEventFromMention(
  m: { channel: string; ts: string; text: string },
  ticketRe: RegExp | null,
): TriggerEvent {
  const ticket = extractTickets(m.text, ticketRe)[0];
  return {
    type: 'slack',
    event: 'mention',
    channel: m.channel,
    key: `slack:${m.channel}:${m.ts}`,
    vars: { slackText: redact(m.text).slice(0, 500), ...(ticket ? { ticket } : {}) },
  };
}

/** Matches the repo name (last segment of `owner/name`) against the basenames of the project's repo paths and path prefixes. */
export function repoBelongsToProject(repoFullName: string, project: ProjectConfig | null): boolean {
  if (!project) return false;
  const name = (repoFullName.split('/').pop() ?? '').toLowerCase();
  if (!name) return false;
  const dirs = [...project.repos.map((r) => r.path), ...project.pathPrefixes];
  return dirs.some((d) => basename(d).toLowerCase() === name);
}

function ticketBelongsToProject(ticket: string | undefined, project: ProjectConfig | null): boolean {
  if (!project || !ticket) return false;
  const re = compileTicketRegex(project.ticketRegex);
  return re === null ? true : extractTickets(ticket, re).length > 0;
}

export function matchesTrigger(a: Automation, e: TriggerEvent, project: ProjectConfig | null): boolean {
  if (!a.enabled) return false;
  const t = a.trigger;
  switch (e.type) {
    case 'github':
      return t.type === 'github' && t.event === e.event && repoBelongsToProject(e.repo, project);
    case 'linear':
      if (t.type !== 'linear' || t.event !== e.event) return false;
      if (t.event === 'labeled' && t.label && t.label.toLowerCase() !== (e.label ?? '').toLowerCase())
        return false;
      return ticketBelongsToProject(e.vars.ticket, project);
    case 'slack':
      return t.type === 'slack' && t.channel === e.channel;
  }
}
