import { ApproveBody, ReplyBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { SessionActions } from '../../services/remote/session-actions.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readJson } from '../json.ts';
import { confirmOr409, whoOf } from '../p6-util.ts';
import { redactInboxItem } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

/**
 * Reply to and approve for app-owned sessions. Remote callers also need a fresh step-up; the
 * remote guard enforces that (`REMOTE_RULES`). Not mounted by `registerAllRoutes` yet: Task 20's
 * `createPhase6().register` mounts it with the other Phase 6 routes.
 */
export function registerSessionActionRoutes(
  app: OrcApp,
  _ctx: DaemonContext,
  d: { actions: SessionActions },
): void {
  app.post('/api/sessions/:source/:id/reply', async (c) => {
    const source = c.req.param('source');
    if (source !== 'claude' && source !== 'codex') throw new ServiceError('not_found', 404, 'unknown source');
    const { text } = await readJson(c, ReplyBody);
    await d.actions.reply({ pk: sessionPk(source, c.req.param('id')), text, ...whoOf(c) });
    return c.json({ ok: true as const });
  });

  app.post('/api/inbox/:id/approve', async (c) => {
    const { confirm } = await readJson(c, ApproveBody);
    confirmOr409(confirm, 'Approve this item? For a plan, the session continues with the plan.');
    return c.json(redactInboxItem(await d.actions.approve({ itemId: c.req.param('id'), ...whoOf(c) })));
  });
}
