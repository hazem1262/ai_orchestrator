import { ApproveBody, ReplyBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { SessionActions } from '../../services/remote/session-actions.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readJson } from '../json.ts';
import { confirmOr409, need, whoOf } from '../p6-util.ts';
import { redactInboxItem } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

/**
 * Reply to and approve for app-owned sessions. Remote callers also need a fresh step-up; the
 * remote guard enforces that (`REMOTE_RULES`). Registered from `registerAllRoutes` with no `deps`:
 * the actions are then read off `ctx.sessionActions` per request (503 while unwired).
 */
export function registerSessionActionRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  deps?: { actions: SessionActions },
): void {
  const actions = () => deps?.actions ?? need(ctx.sessionActions, 'sessionActions');
  app.post('/api/sessions/:source/:id/reply', async (c) => {
    const source = c.req.param('source');
    if (source !== 'claude' && source !== 'codex') throw new ServiceError('not_found', 404, 'unknown source');
    const { text } = await readJson(c, ReplyBody);
    await actions().reply({ pk: sessionPk(source, c.req.param('id')), text, ...whoOf(c) });
    return c.json({ ok: true as const });
  });

  app.post('/api/inbox/:id/approve', async (c) => {
    const { confirm } = await readJson(c, ApproveBody);
    confirmOr409(confirm, 'Approve this item? For a plan, the session continues with the plan.');
    return c.json(redactInboxItem(await actions().approve({ itemId: c.req.param('id'), ...whoOf(c) })));
  });
}
