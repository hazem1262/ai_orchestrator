import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { LinearIssue, ShareSource } from '@orc/api-contract';
import { redact } from '@orc/core';
import { toServiceError } from '../../connectors/errors.ts';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import type { DaemonContext } from '../../context.ts';
import { need, type Who } from '../../http/p6-util.ts';
import { audited } from '../audit/audit.ts';
import { ServiceError } from '../errors.ts';

export type { ShareSource };
export const MAX_SHARE_CHARS = 20_000;
const AUDIT_PREVIEW_CHARS = 300;

export interface ShareService {
  /** Builds the text to share; always redacted, trimmed and capped at `MAX_SHARE_CHARS`. */
  compose(src: ShareSource): Promise<string>;
  commentOnLinear(identifier: string, body: string, who: Who): Promise<void>;
  createFollowUp(
    i: { sessionPk: string; teamKey: string; title: string; description: string; includeRecap: boolean },
    who: Who,
  ): Promise<LinearIssue>;
  postToSlack(channel: string, text: string, who: Who): Promise<{ ts: string }>;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

async function orThrowService<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toServiceError(e);
  }
}

/**
 * Redact → confirm → audit sharing to Linear and Slack, acting as the user. The routes ask for
 * confirmation; every method here posts, so each one records exactly one audit entry (ok or
 * error) with a redacted preview of at most 300 chars, never the full body.
 */
export function createShareService(d: {
  ctx: DaemonContext;
  linear: LinearConnector;
  slack: SlackConnector;
}): ShareService {
  const { ctx } = d;
  const preview = (s: string) => redact(s).slice(0, AUDIT_PREVIEW_CHARS);

  function sessionOf(pk: string) {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
    return s;
  }

  async function planText(planPath: string): Promise<string> {
    if (!isAbsolute(planPath) || !planPath.endsWith('.md')) {
      throw new ServiceError('forbidden', 403, 'plan path must be an absolute .md path');
    }
    let real: string;
    try {
      real = await realpath(planPath);
    } catch {
      throw new ServiceError('not_found', 404, 'plan file not found');
    }
    const roots = [
      join(ctx.paths.claudeHome, 'plans'),
      ...ctx.config().links.planRoots.map((r) => expandHome(r, ctx.paths.userHome)),
    ];
    const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
    if (!realRoots.some((r) => r !== null && real.startsWith(r + sep))) {
      throw new ServiceError('forbidden', 403, 'plan path is outside the plan roots');
    }
    return readFile(real, 'utf8');
  }

  async function compose(src: ShareSource): Promise<string> {
    let text: string;
    switch (src.kind) {
      case 'recap': {
        const s = sessionOf(src.sessionPk);
        const r = await need(ctx.recaps, 'recaps').recap(src.sessionPk, { onDemand: true });
        text = `**Session recap — ${s.name || src.sessionPk}**\n\n${r.text}`;
        break;
      }
      case 'handoff': {
        sessionOf(src.sessionPk);
        const handoffs = need(ctx.handoffs, 'handoffs');
        const h = handoffs.latest(src.sessionPk) ?? (await handoffs.generate(src.sessionPk));
        text = handoffs.toMarkdown(h);
        break;
      }
      case 'plan':
        text = await planText(src.planPath);
        break;
      case 'daily': {
        const body = await need(ctx.recaps, 'recaps').daily(src.projectId, src.date);
        text = `**Daily update — ${src.projectId} — ${src.date}**\n\n${body}`;
        break;
      }
      case 'text':
        text = src.text;
        break;
    }
    const safe = redact(text).trim();
    if (!safe) throw new ServiceError('validation_failed', 400, 'nothing to share');
    return safe.length > MAX_SHARE_CHARS ? `${safe.slice(0, MAX_SHARE_CHARS)}\n\n…(truncated)` : safe;
  }

  return {
    compose,
    async commentOnLinear(identifier, body, who) {
      const audit = need(ctx.audit, 'audit');
      const safe = redact(body);
      await audited(
        audit,
        {
          ...who,
          action: 'linear.comment',
          target: identifier,
          params: { chars: safe.length, preview: preview(safe) },
        },
        () => orThrowService(() => d.linear.comment(identifier, safe)),
      );
    },
    async createFollowUp(i, who) {
      const audit = need(ctx.audit, 'audit');
      const s = sessionOf(i.sessionPk);
      let description = i.description.trim();
      if (i.includeRecap && ctx.recaps) {
        try {
          const r = await ctx.recaps.recap(i.sessionPk, { onDemand: false });
          description = `${description}\n\n### Context\n${r.text}`.trim();
        } catch (err) {
          ctx.log.warn(
            { err: redact(String(err)), sessionPk: i.sessionPk },
            'follow-up recap failed; continuing without it',
          );
        }
      }
      const related = s.tickets.length > 0 ? `, related: ${s.tickets.join(', ')}` : '';
      description =
        `${description}\n\n---\nFollow-up from Orchestrator session “${s.name || i.sessionPk}” (\`${i.sessionPk}\`)${related}.`.trim();
      const title = redact(i.title).trim();
      const safeDescription = redact(description);
      return audited(
        audit,
        {
          ...who,
          action: 'linear.issue.create',
          target: i.teamKey,
          params: { title: preview(title), sessionPk: i.sessionPk },
        },
        () =>
          orThrowService(() =>
            d.linear.createIssue({
              teamKey: i.teamKey,
              title,
              description: safeDescription,
              assignToMe: true,
            }),
          ),
      );
    },
    async postToSlack(channel, text, who) {
      const audit = need(ctx.audit, 'audit');
      const safe = redact(text);
      return audited(
        audit,
        {
          ...who,
          action: 'slack.post',
          target: channel,
          params: { chars: safe.length, preview: preview(safe) },
        },
        () => orThrowService(() => d.slack.post(channel, safe)),
      );
    },
  };
}
