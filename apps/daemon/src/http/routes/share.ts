import {
  LINEAR_IDENTIFIER_RE,
  LinearCommentBody,
  LinearFollowUpBody,
  SlackPostBody,
} from '@orc/api-contract';
import { redact } from '@orc/core';
import { toServiceError } from '../../connectors/errors.ts';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { ShareService } from '../../services/share/share.ts';
import { readJson } from '../json.ts';
import { confirmOr409, need, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export interface ShareRouteDeps {
  share: ShareService;
  linear: LinearConnector;
}

function identifierParam(raw: string): string {
  const id = decodeURIComponent(raw).trim().toUpperCase();
  if (!LINEAR_IDENTIFIER_RE.test(id)) {
    throw new ServiceError('validation_failed', 400, 'not a Linear identifier');
  }
  return id;
}

/**
 * Linear issue lookup, Linear comments, follow-up tickets and Slack posts.
 *
 * Every post is two steps: without `confirm: true` it answers `409 confirmation_required` with the
 * redacted preview and posts nothing; the client re-sends the previewed text to post it. The
 * service records the audit entry. Registered from `registerAllRoutes` with no `deps`: the share
 * service and the Linear connector are then read off `ctx` per request (503 while unwired).
 */
export function registerShareRoutes(app: OrcApp, ctx: DaemonContext, d?: ShareRouteDeps): void {
  const share = () => d?.share ?? need(ctx.share, 'share');
  const linear = () => d?.linear ?? need(ctx.linear, 'linear');

  app.get('/api/linear/issues/:identifier', async (c) => {
    const id = identifierParam(c.req.param('identifier'));
    let issue: Awaited<ReturnType<LinearConnector['issue']>>;
    try {
      issue = await linear().issue(id);
    } catch (e) {
      throw toServiceError(e);
    }
    if (!issue) throw new ServiceError('not_found', 404, `Linear issue ${id} not found`);
    return c.json(issue);
  });

  app.post('/api/linear/issues/:identifier/comment', async (c) => {
    const id = identifierParam(c.req.param('identifier'));
    const body = await readJson(c, LinearCommentBody);
    const text = await share().compose(body.source);
    confirmOr409(body.confirm, `Post this comment on ${id} in Linear as you?`, { preview: text, target: id });
    await share().commentOnLinear(id, text, whoOf(c));
    return c.json({ ok: true as const });
  });

  app.post('/api/linear/follow-up', async (c) => {
    const body = await readJson(c, LinearFollowUpBody);
    const firstTicket = ctx.sessions.getByPk(body.sessionPk)?.tickets[0] ?? null;
    const teamKey =
      body.teamKey ?? ctx.config().connectors.linear.defaultTeamKey ?? firstTicket?.split('-')[0] ?? null;
    if (!teamKey) throw new ServiceError('validation_failed', 400, 'choose a Linear team (teamKey)');
    confirmOr409(body.confirm, `Create a Linear issue in ${teamKey} as you, assigned to you?`, {
      preview: redact(`${body.title}\n\n${body.description}`.trim()),
      teamKey,
    });
    const issue = await share().createFollowUp(
      {
        sessionPk: body.sessionPk,
        teamKey,
        title: body.title,
        description: body.description,
        includeRecap: body.includeRecap,
      },
      whoOf(c),
    );
    return c.json(issue);
  });

  app.post('/api/slack/post', async (c) => {
    const body = await readJson(c, SlackPostBody);
    const channel = body.channel ?? ctx.config().connectors.slack.dailyChannel;
    if (!channel) {
      throw new ServiceError(
        'validation_failed',
        400,
        'no channel given and connectors.slack.dailyChannel is not set',
      );
    }
    const text = await share().compose(body.source);
    confirmOr409(body.confirm, `Post this to Slack channel ${channel} as you?`, { preview: text, channel });
    return c.json(await share().postToSlack(channel, text, whoOf(c)));
  });
}
