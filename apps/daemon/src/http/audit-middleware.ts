import type { AuditActor } from '@orc/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { DaemonContext } from '../context.ts';

export interface AuditedRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  pattern: RegExp;
  action: string | ((body: Record<string, unknown>) => string);
  target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null;
  /** Runs before the handler (e.g. to capture state the handler destroys). */
  before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown>;
}

const SRC = '(claude|codex|agnc)';
const dec = (s: string | undefined) => decodeURIComponent(s ?? '');
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sessionTarget = (m: RegExpExecArray) => `${m[1]}:${dec(m[2])}`;

export const AUDITED_ROUTES: AuditedRoute[] = [
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/resume$`),
    action: (b) => (b.fork === true ? 'session.fork' : 'session.resume'),
    target: sessionTarget,
  },
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/launch$/,
    action: 'session.launch',
    target: (_m, b) => str(b.cwd),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/kill$`),
    action: 'session.kill',
    target: sessionTarget,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/pty\/([^/]+)$/,
    action: 'session.kill',
    target: (m) => `pty:${dec(m[1])}`,
    before: (m, ctx) => ({ sessionPk: ctx.pty.get(dec(m[1]))?.sessionPk ?? null }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/archive\/restore$/,
    action: 'archive.restore',
    target: (_m, b) => {
      const source = str(b.source);
      const id = str(b.id);
      return source && id ? `${source}:${id}` : null;
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/open-in$`),
    action: 'session.open',
    target: sessionTarget,
  },
  {
    method: 'POST',
    pattern: /^\/api\/archive\/sync$/,
    action: 'archive.sync',
    target: () => null,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/export$`),
    action: 'session.export',
    target: sessionTarget,
  },
];

/** Write routes that are local UI/config state, not actions on sessions or external systems. Every entry needs a reason. */
export const NON_ACTION_ROUTES: Array<{ method: string; path: string; why: string }> = [
  { method: 'PATCH', path: '/api/projects/:id', why: 'local app configuration' },
  { method: 'POST', path: '/api/sessions/:source/:id/pin', why: 'local UI state' },
  { method: 'POST', path: '/api/sessions/:source/:id/label', why: 'local UI state' },
  { method: 'POST', path: '/api/views', why: 'local UI state (saved views)' },
  { method: 'DELETE', path: '/api/views/:id', why: 'local UI state (saved views)' },
  { method: 'POST', path: '/api/inbox/:id/:action{done|snooze|reopen}', why: 'local triage state' },
  { method: 'PUT', path: '/api/config/notifications', why: 'local app configuration' },
  { method: 'POST', path: '/api/hooks', why: 'inbound events from Claude hooks, not an app action' },
  { method: 'POST', path: '/api/safety/deny-check', why: 'read-only evaluation' },
];

export function matchAuditedRoute(
  method: string,
  path: string,
): { route: AuditedRoute; m: RegExpExecArray } | null {
  for (const route of AUDITED_ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, m };
  }
  return null;
}

function actorOf(c: Context): AuditActor {
  // Phase 6 sets this header server-side for remote requests; automations/supervisor record through audited() directly.
  const h = c.req.header('x-orc-actor');
  return h === 'automation' || h === 'supervisor' || h === 'remote' ? h : 'user';
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return {};
  try {
    // Hono caches the parsed body, so the handler can still call c.req.json().
    const v: unknown = await c.req.json();
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

export function auditMiddleware(ctx: DaemonContext): MiddlewareHandler {
  return async (c, next) => {
    const hit = matchAuditedRoute(c.req.method, c.req.path);
    if (!hit) {
      await next();
      return;
    }
    const audit = ctx.audit;
    const body = await readJsonBody(c);
    const before = hit.route.before?.(hit.m, ctx) ?? {};

    await next();

    const res = c.res;
    const parsed: unknown = (res.headers.get('content-type') ?? '').includes('application/json')
      ? await res
          .clone()
          .json()
          .catch(() => null)
      : null;
    const obj = isObj(parsed) ? parsed : null;
    const err = obj && isObj(obj.error) ? obj.error : null;
    const code = err ? str(err.code) : null;
    if (res.status === 409 && code === 'confirmation_required') return;

    const { confirm: _confirm, ...rest } = body;
    const result = res.status < 400 ? 'ok' : res.status === 403 ? 'denied' : 'error';
    const outcome: Record<string, unknown> = {};
    if (result === 'ok' && obj) {
      for (const k of ['ptyId', 'sessionId', 'launched']) if (k in obj) outcome[k] = obj[k];
    }
    const message = err ? (str(err.message) ?? '') : '';
    audit.record({
      actor: actorOf(c),
      actorDetail: c.req.header('user-agent')?.slice(0, 120) ?? null,
      action: typeof hit.route.action === 'string' ? hit.route.action : hit.route.action(body),
      target: hit.route.target(hit.m, body),
      params: { ...rest, ...c.req.query(), ...before, ...outcome, status: res.status },
      result,
      error: result === 'ok' ? null : `${code ?? `http_${res.status}`}: ${message}`.trim(),
    });
  };
}
