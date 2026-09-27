import type { IncomingMessage } from 'node:http';
import { type HeaderGetter, isRemoteRequest } from '../remote/classify.ts';
import type { RemoteInfo } from './p6-util.ts';
import { evaluateRemote, type RemoteGuardDeps } from './remote-guard.ts';
import { parseUpgradeTarget } from './upgrade-target.ts';

export type WsVerdict =
  | { ok: true; remote: RemoteInfo | null }
  | { ok: false; status: 401 | 403; code: string };

/**
 * Local upgrades return `remote: null` and continue to the existing token and Origin checks.
 * Remote upgrades go through the same checks as `remoteGuard`, with the device token taken from
 * the query or the `x-orc-token` header. Never throws: it runs inside the `upgrade` listener.
 */
export function checkWsUpgrade(req: IncomingMessage, d: RemoteGuardDeps | null): WsVerdict {
  const get: HeaderGetter = (name) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  if (d === null || !isRemoteRequest(get, req.socket?.remoteAddress ?? null))
    return { ok: true, remote: null };
  const target = parseUpgradeTarget(req.url);
  if (!target) return { ok: false, status: 403, code: 'remote_forbidden' };
  const v = evaluateRemote(
    { method: 'GET', path: target.path, get, token: target.query.get('token') ?? get('x-orc-token') ?? null },
    d,
  );
  return v.ok ? { ok: true, remote: v.remote } : { ok: false, status: v.status, code: v.code };
}
