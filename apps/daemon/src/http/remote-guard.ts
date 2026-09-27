import type { OrcConfig } from '@orc/api-contract';
import type { MiddlewareHandler } from 'hono';
import { type HeaderGetter, hostnameOf, isRemoteRequest, loginMatches } from '../remote/classify.ts';
import type { DeviceService } from '../remote/devices.ts';
import type { StepUpStore } from '../remote/step-up.ts';
import type { FunnelWatch } from '../remote/tailscale.ts';
import type { RemoteInfo } from './p6-util.ts';
import { redactedApiError } from './redact-out.ts';
import type { OrcEnv } from './types.ts';

export type RemotePolicy = 'public' | 'device' | 'stepup' | 'deny';

/** First match wins; anything unmatched falls through to the defaults in `remotePolicy`. */
export const REMOTE_RULES: ReadonlyArray<{ method: string; pattern: RegExp; policy: RemotePolicy }> = [
  { method: 'GET', pattern: /^\/api\/connectors\/(linear|slack)\/callback$/, policy: 'public' },
  { method: 'POST', pattern: /^\/api\/remote\/pair$/, policy: 'public' },
  { method: 'GET', pattern: /^\/api\/health$/, policy: 'public' },
  // The AGNC OAuth redirect goes to 127.0.0.1 only; a remote device never finishes it.
  { method: 'GET', pattern: /^\/oauth\//, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/remote\/(devices|pairing)/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/connectors/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/sessions\/[^/]+\/[^/]+\/(export|raw)$/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/(safety\/secrets|hooks\/install|archive)/, policy: 'deny' },
  { method: 'POST', pattern: /^\/api\/webauthn\/(register|stepup)\/(options|verify)$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/push\/(subscriptions|test)$/, policy: 'device' },
  { method: 'DELETE', pattern: /^\/api\/push\/subscriptions$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/remote\/away$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/inbox\/[^/]+\/(snooze|done|reopen)$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/inbox\/[^/]+\/approve$/, policy: 'stepup' },
  { method: 'POST', pattern: /^\/api\/sessions\/(claude|codex)\/[^/]+\/(reply|kill)$/, policy: 'stepup' },
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/(claude|codex)\/[^/]+\/plan\/(approve|reject)$/,
    policy: 'stepup',
  },
  { method: 'DELETE', pattern: /^\/api\/pty\/[^/]+$/, policy: 'stepup' },
  { method: 'POST', pattern: /^\/api\/ship\/merge$/, policy: 'stepup' },
];

/** Defaults: API reads need a device, API writes and terminals are denied, static GETs are public. */
export function remotePolicy(method: string, path: string): RemotePolicy {
  const m = method.toUpperCase();
  for (const r of REMOTE_RULES) if (r.method === m && r.pattern.test(path)) return r.policy;
  if (path === '/ws') return m === 'GET' ? 'device' : 'deny';
  if (path === '/pty' || path.startsWith('/pty/')) return 'deny';
  if (path === '/api' || path.startsWith('/api/')) return m === 'GET' ? 'device' : 'deny';
  return m === 'GET' || m === 'HEAD' ? 'public' : 'deny';
}

export interface RemoteGuardDeps {
  config: () => OrcConfig;
  devices: DeviceService;
  stepUp: StepUpStore;
  funnel: Pick<FunnelWatch, 'detected'>;
}

export type RemoteVerdict =
  | { ok: true; remote: RemoteInfo }
  | { ok: false; status: 401 | 403; code: string; message: string };

function originOf(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * The remote checks, in order. `allowedLogin` is the real gate: the tailnet is shared, so every
 * device the ACLs allow can reach the `tailscale serve` origin. A missing or blank `allowedLogin`
 * disables remote access outright.
 */
export function evaluateRemote(
  r: { method: string; path: string; get: HeaderGetter; token: string | null },
  d: RemoteGuardDeps,
): RemoteVerdict {
  const deny = (status: 401 | 403, code: string, message: string): RemoteVerdict => ({
    ok: false,
    status,
    code,
    message,
  });
  const cfg = d.config().remote;
  const allowedLogin = cfg.allowedLogin?.trim() ?? '';
  const origin = cfg.origin ? originOf(cfg.origin) : null;
  if (!cfg.enabled || origin === null || allowedLogin === '') {
    return deny(403, 'remote_disabled', 'remote access is disabled (Settings → Remote)');
  }
  if (d.funnel.detected()) {
    return deny(403, 'funnel_detected', 'Tailscale Funnel is on; run `tailscale funnel --https=443 off`');
  }
  const login = r.get('tailscale-user-login') ?? '';
  if (!loginMatches(login, allowedLogin)) {
    return deny(403, 'remote_identity_mismatch', 'this Tailscale user may not use the app');
  }
  if (hostnameOf(r.get('x-forwarded-host') ?? r.get('host')) !== origin.hostname) {
    return deny(403, 'remote_bad_host', 'unexpected host');
  }
  const reqOrigin = r.get('origin');
  if (reqOrigin !== undefined && reqOrigin !== origin.origin)
    return deny(403, 'forbidden', 'origin not allowed');
  const policy = remotePolicy(r.method, r.path);
  if (policy === 'deny') return deny(403, 'remote_forbidden', 'not available from a remote device');
  const who = login.trim();
  if (policy === 'public') return { ok: true, remote: { deviceId: null, deviceName: null, login: who } };
  const device = d.devices.verify(r.token);
  if (!device) return deny(401, 'unauthorized', 'pair this device first');
  if (policy === 'stepup' && !d.stepUp.valid(device.id)) {
    return deny(401, 'step_up_required', 'confirm with your passkey');
  }
  return { ok: true, remote: { deviceId: device.id, deviceName: device.name, login: who } };
}

/**
 * Sets `c.var.remote` for every request: `null` for local requests, the verified identity for
 * remote ones. `remoteGuard(null)` marks every request as local (P1 tests only).
 */
export function remoteGuard(d: RemoteGuardDeps | null): MiddlewareHandler<OrcEnv> {
  return async (c, next) => {
    const get: HeaderGetter = (n) => c.req.header(n);
    const addr = c.env?.incoming?.socket?.remoteAddress ?? null;
    if (d === null || !isRemoteRequest(get, addr)) {
      c.set('remote', null);
      await next();
      return;
    }
    const v = evaluateRemote(
      {
        method: c.req.method,
        path: c.req.path,
        get,
        token: c.req.header('x-orc-token') ?? c.req.query('token') ?? null,
      },
      d,
    );
    if (!v.ok) return c.json(redactedApiError(v.code, v.message), v.status);
    c.set('remote', v.remote);
    await next();
  };
}
