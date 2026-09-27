import { type InboxItem, redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { need, type Who } from '../../http/p6-util.ts';
import { actorScope } from '../audit/actor-scope.ts';
import { audited } from '../audit/audit.ts';
import { ServiceError } from '../errors.ts';
import { sessionPk } from '../sessions.ts';

export const DEFAULT_APPROVE_TEXT = 'Approved — proceed with the plan.';
const MAX_REPLY = 8000;
const PK_RE = /^(?:claude|codex|agnc):\S+$/;

export interface SessionActions {
  reply(i: { pk: string; text: string } & Who): Promise<void>;
  approve(i: { itemId: string } & Who): Promise<InboxItem>;
}

function pkFromDedupeKey(key: string): string | null {
  // The shipped composer: `${kind}:session:${encodeURIComponent(pk)}[:${facet}]`.
  const composed = /^[a-z_]+:session:([^:]+)(?::|$)/.exec(key);
  if (composed?.[1]) {
    try {
      const pk = decodeURIComponent(composed[1]);
      if (PK_RE.test(pk)) return pk;
    } catch {
      // not percent-encoded; fall through
    }
  }
  // The plain `<kind>:<pk>` form (P2 convention, P4 `plan:${pk}`).
  const plain = /^[a-z_]+:((?:claude|codex|agnc):.+)$/.exec(key);
  return plain?.[1] ?? null;
}

/** The session an inbox item is about: payload, then dedupe key, then `sessionId`. */
export function inboxSessionPk(item: InboxItem): string | null {
  const src = item.payload.source;
  const id = item.payload.id;
  if ((src === 'claude' || src === 'codex' || src === 'agnc') && typeof id === 'string')
    return sessionPk(src, id);
  const fromKey = pkFromDedupeKey(item.dedupeKey);
  if (fromKey) return fromKey;
  if (item.sessionId?.includes(':')) return item.sessionId;
  return item.sessionId ? sessionPk('claude', item.sessionId) : null;
}

export function createSessionActions(ctx: DaemonContext): SessionActions {
  function ownedPty(pk: string): { ptyId: string; projectId: string | null } {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
    const live = s.live;
    if (live?.ownership !== 'owned' || !live.ptyId) {
      throw new ServiceError('not_owned', 403, 'input is only sent to sessions running in the app');
    }
    return { ptyId: live.ptyId, projectId: s.projectId };
  }

  async function reply(i: { pk: string; text: string } & Who): Promise<void> {
    const text = i.text.trim();
    if (!text) throw new ServiceError('validation_failed', 400, 'empty reply');
    if (text.length > MAX_REPLY) throw new ServiceError('validation_failed', 400, 'reply is too long');
    const { ptyId, projectId } = ownedPty(i.pk);
    if (i.actor !== 'user') {
      const verdict = ctx.denyList.check(text, projectId);
      if (verdict.denied) {
        ctx.audit.record({
          actor: i.actor,
          actorDetail: i.actorDetail,
          action: 'pty.input',
          target: i.pk,
          params: { via: 'remote', text: redact(text).slice(0, 500) },
          result: 'denied',
          error: verdict.reason,
        });
        throw new ServiceError(
          'denied',
          403,
          `blocked by the deny-list: ${verdict.reason ?? 'matched a pattern'}`,
        );
      }
    }
    await actorScope.run({ actor: i.actor, actorDetail: i.actorDetail }, () => ctx.pty.sendText(ptyId, text));
  }

  async function approve(i: { itemId: string } & Who): Promise<InboxItem> {
    const inbox = need(ctx.inbox, 'inbox');
    const find = () => inbox.list({}).find((x) => x.id === i.itemId);
    const item = find();
    if (!item) throw new ServiceError('not_found', 404, 'inbox item not found');
    if (item.state === 'done' || item.state === 'auto_resolved') {
      throw new ServiceError('not_approvable', 409, 'this item is already closed');
    }
    const pk = inboxSessionPk(item);
    return audited(
      ctx.audit,
      {
        actor: i.actor,
        actorDetail: i.actorDetail,
        action: i.actor === 'remote' ? 'remote.approve' : 'inbox.approve',
        target: item.id,
        params: { kind: item.kind, sessionPk: pk },
      },
      async () => {
        if (item.kind === 'plan_approval') {
          if (!pk) throw new ServiceError('not_approvable', 409, 'plan item has no session');
          ownedPty(pk);
          const plans = ctx.plans;
          if (plans) {
            await actorScope.run({ actor: i.actor, actorDetail: i.actorDetail }, () => plans.approve(pk));
          } else {
            const text =
              typeof item.payload.approveText === 'string' ? item.payload.approveText : DEFAULT_APPROVE_TEXT;
            await reply({ pk, text, actor: i.actor, actorDetail: i.actorDetail });
          }
          // P4's approve may already have closed the item.
          const fresh = find() ?? item;
          return fresh.state === 'open' || fresh.state === 'snoozed' ? inbox.markDone(item.id) : fresh;
        }
        if (item.kind === 'automation_result') return inbox.markDone(item.id);
        throw new ServiceError('not_approvable', 409, `${item.kind} items cannot be approved`);
      },
    );
  }

  return { reply, approve };
}
