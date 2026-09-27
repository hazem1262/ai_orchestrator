import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { AutomationServiceImpl } from './service.ts';
import {
  githubEventsFromPrChange,
  linearEventsFromIssueChange,
  matchesTrigger,
  slackEventFromMention,
  type TriggerEvent,
} from './triggers.ts';

/**
 * Subscribes to the bus events that Phase 4 (`pr.changed`) and the Phase 6 pollers
 * (`linear.issueChanged`, `slack.mention`) emit, and starts every enabled automation whose
 * trigger matches. Dedupe per trigger key is the service's job.
 */
export function attachTriggerDispatcher(
  ctx: DaemonContext,
  svc: Pick<AutomationServiceImpl, 'list' | 'start'>,
): () => void {
  const slackRe = compileTicketRegex(DEFAULT_TICKET_REGEX);
  const handle = (events: TriggerEvent[]) => {
    if (events.length === 0) return;
    const enabled = svc.list().filter((a) => a.enabled);
    for (const e of events) {
      for (const a of enabled) {
        if (!matchesTrigger(a, e, ctx.projects.get(a.action.projectId))) continue;
        svc.start(a.id, { key: e.key, source: e.type, vars: e.vars }).catch((err: unknown) => {
          ctx.log.warn({ err, automationId: a.id, key: e.key }, 'automation trigger failed');
        });
      }
    }
  };
  const offs = [
    ctx.bus.on('pr.changed', (e) => handle(githubEventsFromPrChange(e.before, e.after))),
    ctx.bus.on('linear.issueChanged', (e) => handle(linearEventsFromIssueChange(e.before, e.after))),
    ctx.bus.on('slack.mention', (e) => handle([slackEventFromMention(e, slackRe)])),
  ];
  return () => {
    for (const off of offs) off();
  };
}
