import type { AuditActor } from '@orc/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { DaemonContext } from '../context.ts';
import { withAuditScope } from '../services/audit/audit.ts';

export interface AuditedRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  pattern: RegExp;
  action: string | ((body: Record<string, unknown>) => string);
  target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null;
  /** Runs before the handler (e.g. to capture state the handler destroys). */
  before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown>;
  /**
   * `'service'`: the service behind this route already records `action` through `runAudited`
   * (phase 4 git/gh/pty writes). The middleware writes an entry only when the request fails
   * before the service recorded that action (bad body, unknown path, ownership check).
   */
  recordedBy?: 'service';
  /** Body keys left out of the params this middleware records (user text sent elsewhere). */
  omitParams?: string[];
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
    pattern: /^\/api\/handoffs\/([^/]+)\/resume-fresh$/,
    action: 'session.launch',
    target: (m) => `handoff:${dec(m[1])}`,
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
  }, // Phase 4 writes. Each service records the action itself through `runAudited`, with the
  // service-level target and params, so these rows only mark the routes as audited.
  {
    method: 'POST',
    pattern: /^\/api\/worktrees$/,
    action: 'worktree.create',
    target: (_m, b) => str(b.repo),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/worktrees\/script$/,
    action: 'worktree.script',
    target: (_m, b) => str(b.path),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/worktrees\/open$/,
    action: 'worktree.open',
    target: (_m, b) => str(b.path),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/worktrees\/sync$/,
    action: 'worktree.sync',
    target: (_m, b) => str(b.path),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/worktrees\/archive$/,
    action: 'worktree.archive',
    target: (_m, b) => str(b.path),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/diff\/revert$/,
    action: 'git.revert',
    target: (_m, b) => str(b.cwd),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/checkpoints$/,
    action: 'checkpoint.create',
    target: (_m, b) => str(b.sessionPk),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/checkpoints\/([^/]+)\/rewind$/,
    action: 'checkpoint.rewind',
    target: (m) => dec(m[1]),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/review/${SRC}/([^/]+)/comments$`),
    action: 'review.send',
    target: sessionTarget,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/ship\/commit$/,
    action: 'git.commit',
    target: (_m, b) => str(b.cwd),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/ship\/push$/,
    action: 'git.push',
    target: (_m, b) => str(b.cwd),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/ship\/pr$/,
    action: 'pr.create',
    target: (_m, b) => str(b.cwd),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/ship\/merge$/,
    action: 'pr.merge',
    target: (_m, b) => (isObj(b.pr) ? `${String(b.pr.repo)}#${String(b.pr.number)}` : null),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/ship\/backmerge$/,
    action: 'ship.backmerge',
    target: (_m, b) => str(b.cwd),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/plan/approve$`),
    action: 'plan.approve',
    target: sessionTarget,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/plan/reject$`),
    action: 'plan.reject',
    target: sessionTarget,
    recordedBy: 'service',
  },
  // Phase 6 connectors. Each handler records its own entry through `audited()` so the params
  // never carry the pasted token or the OAuth client secret.
  {
    method: 'POST',
    pattern: /^\/api\/connectors\/([^/]+)\/token$/,
    action: 'connector.connect',
    target: (m) => dec(m[1]),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/connectors\/([^/]+)\/app$/,
    action: 'connector.configure',
    target: (m) => dec(m[1]),
    recordedBy: 'service',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/connectors\/([^/]+)$/,
    action: 'connector.disconnect',
    target: (m) => dec(m[1]),
    recordedBy: 'service',
  },
  // Phase 6 sharing. `ShareService` records each post through `audited()` with a redacted preview
  // of at most 300 chars, never the full body; a 409 confirmation_required is not recorded.
  {
    method: 'POST',
    pattern: /^\/api\/linear\/issues\/([^/]+)\/comment$/,
    action: 'linear.comment',
    target: (m) => dec(m[1]),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/linear\/follow-up$/,
    action: 'linear.issue.create',
    target: (_m, b) => str(b.teamKey),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/slack\/post$/,
    action: 'slack.post',
    target: (_m, b) => str(b.channel),
    recordedBy: 'service',
  },
  // Phase 7 automations. `AutomationService` and the settings handler record each entry with the
  // real actor and parameters; the middleware records only a request that fails before they do.
  {
    method: 'POST',
    pattern: /^\/api\/automations$/,
    action: 'settings.update',
    target: (_m, b) => (str(b.id) ? `automation:${str(b.id)}` : null),
    recordedBy: 'service',
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/automations\/settings$/,
    action: 'settings.update',
    target: () => 'config:automations',
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/suggestions\/([^/]+)\/accept$/,
    action: 'session.launch',
    target: (m) => `suggestion:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/runs\/([^/]+)\/approve$/,
    action: 'automation.approve',
    target: (m) => `automation-run:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/runs\/([^/]+)\/reject$/,
    action: 'automation.reject',
    target: (m) => `automation-run:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/runs\/([^/]+)\/rerun$/,
    action: 'automation.run',
    target: (m) => `automation-run:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/automations\/([^/]+)$/,
    action: 'settings.update',
    target: (m) => `automation:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/([^/]+)\/enabled$/,
    action: 'settings.update',
    target: (m) => `automation:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/automations\/([^/]+)\/run$/,
    action: 'automation.run',
    target: (m) => `automation:${dec(m[1])}`,
    recordedBy: 'service',
  },
  // Phase 7 compare mode. `CompareService` records each entry with the variants, index or
  // per-worktree results; the middleware records only a request that fails before it does.
  {
    method: 'POST',
    pattern: /^\/api\/compare$/,
    action: 'compare.launch',
    target: () => null,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/compare\/([^/]+)\/winner$/,
    action: 'compare.pick',
    target: (m) => `compare:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/compare\/([^/]+)\/archive-losers$/,
    action: 'compare.archive',
    target: (m) => `compare:${dec(m[1])}`,
    recordedBy: 'service',
  },
  // Phase 7 supervisor. The settings handler and `Supervisor` record each entry with the real
  // actor and parameters; the middleware records only a request that fails before they do.
  // `evaluate` records `supervisor.answer` or `supervisor.escalate` itself (nothing on a dry run).
  {
    method: 'PATCH',
    pattern: /^\/api\/supervisor\/settings$/,
    action: 'settings.update',
    target: () => 'config:supervisor',
    recordedBy: 'service',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/supervisor\/targets$/,
    action: 'settings.update',
    target: (_m, b) =>
      str(b.targetType) && str(b.targetId) ? `supervisor:${str(b.targetType)}:${str(b.targetId)}` : null,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/supervisor\/rules$/,
    action: 'supervisor.rule',
    target: () => null,
    recordedBy: 'service',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/supervisor\/rules\/([^/]+)$/,
    action: 'supervisor.rule',
    target: (m) => `supervisor-rule:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/supervisor\/decisions\/([^/]+)\/wrong$/,
    action: 'supervisor.feedback',
    target: (m) => `supervisor-decision:${dec(m[1])}`,
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/supervisor/evaluate/${SRC}/([^/]+)$`),
    action: 'supervisor.evaluate',
    target: sessionTarget,
    recordedBy: 'service',
  },
  // Phase 7 AGNC. The handlers record each entry through `audited()` with the real actor; the
  // middleware records only a request that fails before they do. The prompt text is never logged.
  {
    method: 'POST',
    pattern: /^\/api\/connectors\/agnc\/connect$/,
    action: 'agnc.connect',
    target: () => 'agnc',
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/connectors\/agnc\/disconnect$/,
    action: 'agnc.disconnect',
    target: () => 'agnc',
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/agnc\/sessions\/([^/]+)\/prompt$/,
    action: 'agnc.prompt',
    target: (m) => `agnc:${dec(m[1])}`,
    recordedBy: 'service',
    omitParams: ['prompt'],
  },
  {
    method: 'POST',
    pattern: /^\/api\/agnc\/handoff$/,
    action: 'agnc.create',
    target: (_m, b) => (str(b.source) && str(b.id) ? `${str(b.source)}:${str(b.id)}` : null),
    recordedBy: 'service',
  },
  {
    method: 'POST',
    pattern: /^\/api\/hooks\/install$/,
    action: 'hook.install',
    target: () => 'claude-settings',
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
  {
    method: 'POST',
    path: '/api/worktrees/discover',
    why: 'refreshes the local worktree index; read-only git',
  },
  { method: 'PUT', path: '/api/usage/budgets', why: 'local budget configuration' },
  { method: 'DELETE', path: '/api/usage/budgets/:id', why: 'local budget configuration' },
  { method: 'POST', path: '/api/usage/official', why: 'inbound statusline sample, not an app action' },
  { method: 'PUT', path: '/api/settings', why: 'local app configuration' },
  { method: 'POST', path: '/api/streams/refresh', why: 'recomputes local stream metadata' },
  { method: 'POST', path: '/api/streams/:ticket/link', why: 'local stream metadata' },
  { method: 'POST', path: '/api/streams/:ticket/unlink', why: 'local stream metadata' },
  {
    method: 'POST',
    path: '/api/analytics/digest',
    why: 'renders a local markdown digest; nothing is sent anywhere',
  },
  {
    method: 'POST',
    path: '/api/recaps/session/:source/:id',
    why: 'redacted digest to the configured recap engine; cost tracked in recaps',
  },
  {
    method: 'POST',
    path: '/api/recaps/daily',
    why: 'redacted session list to the configured recap engine; cost tracked in recaps',
  },
  { method: 'PUT', path: '/api/goals/:targetType/:targetId', why: 'local goal metadata' },
  {
    method: 'POST',
    path: '/api/reminders',
    why: 'schedules a local reminder; its PTY input is audited by withPtyInputAudit when it fires',
  },
  { method: 'POST', path: '/api/reminders/:id/cancel', why: 'local reminder state' },
  {
    method: 'POST',
    path: '/api/handoffs/session/:source/:id',
    why: 'builds a local handoff; the redacted digest goes to the configured recap engine',
  },
  // Phase 6 routes that record their own audit entries, or change nothing outside this Mac. The
  // connector and share posts are in AUDITED_ROUTES above, not here.
  {
    method: 'POST',
    path: '/api/sessions/:source/:id/reply',
    why: 'audited by withPtyInputAudit as pty.input (a deny-list block is recorded as denied)',
  },
  {
    method: 'POST',
    path: '/api/inbox/:id/approve',
    why: 'audited in SessionActions as remote.approve or inbox.approve',
  },
  { method: 'POST', path: '/api/remote/config', why: 'audited in the route as remote.configure' },
  { method: 'POST', path: '/api/remote/pairing', why: 'audited in the route as remote.pairing_code' },
  {
    method: 'POST',
    path: '/api/remote/pair',
    why: 'audited in the route as remote.pair, including a wrong code',
  },
  { method: 'DELETE', path: '/api/remote/devices/:id', why: 'audited in the route as remote.revoke' },
  { method: 'POST', path: '/api/remote/away', why: 'audited in the route as away.set' },
  { method: 'POST', path: '/api/webauthn/register/options', why: 'issues a challenge; no state change' },
  { method: 'POST', path: '/api/webauthn/register/verify', why: 'audited in the route as webauthn.register' },
  { method: 'POST', path: '/api/webauthn/stepup/options', why: 'issues a challenge; no state change' },
  {
    method: 'POST',
    path: '/api/webauthn/stepup/verify',
    why: 'grants a step-up; the guarded action it unlocks is audited',
  },
  { method: 'POST', path: '/api/push/subscriptions', why: 'device-local notification preference' },
  { method: 'DELETE', path: '/api/push/subscriptions', why: 'device-local notification preference' },
  { method: 'POST', path: '/api/push/test', why: 'sends a test notification to the user’s own devices only' },
  {
    method: 'POST',
    path: '/api/automations/suggestions/refresh',
    why: 'read-only collection from Linear and git into the local suggestions table',
  },
  { method: 'POST', path: '/api/automations/suggestions/:id/dismiss', why: 'local state only, nothing runs' },
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
    const action = typeof hit.route.action === 'string' ? hit.route.action : hit.route.action(body);

    if (hit.route.recordedBy === 'service') {
      const recorded = await withAuditScope(next);
      if (c.res.status < 400 || recorded.has(action)) return;
    } else {
      await next();
    }

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
    for (const k of hit.route.omitParams ?? []) delete rest[k];
    const result = res.status < 400 ? 'ok' : res.status === 403 ? 'denied' : 'error';
    const outcome: Record<string, unknown> = {};
    if (result === 'ok' && obj) {
      for (const k of ['ptyId', 'sessionId', 'launched', 'compareGroupId']) if (k in obj) outcome[k] = obj[k];
    }
    const message = err ? (str(err.message) ?? '') : '';
    audit.record({
      actor: actorOf(c),
      actorDetail: c.req.header('user-agent')?.slice(0, 120) ?? null,
      action,
      target: hit.route.target(hit.m, body),
      params: { ...rest, ...c.req.query(), ...before, ...outcome, status: res.status },
      result,
      error: result === 'ok' ? null : `${code ?? `http_${res.status}`}: ${message}`.trim(),
    });
  };
}
