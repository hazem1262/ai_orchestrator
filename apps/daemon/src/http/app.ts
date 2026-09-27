import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DaemonContext } from '../context.ts';
import { ServiceError } from '../services/errors.ts';
import { auditMiddleware } from './audit-middleware.ts';
import { apiAccessMiddleware, bootstrapHandler } from './auth.ts';
import { redactedApiError } from './redact-out.ts';
import { type RemoteGuardDeps, remoteGuard } from './remote-guard.ts';
import { registerAgncOAuthRoute, registerAgncRoutes } from './routes/agnc.ts';
import { registerAnalyticsRoutes } from './routes/analytics.ts';
import { registerArchiveRoutes } from './routes/archive.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerAutomationRoutes } from './routes/automations.ts';
import { registerAwayRoutes } from './routes/away.ts';
import { registerCompareRoutes } from './routes/compare.ts';
import { registerConnectorRoutes } from './routes/connectors.ts';
import { registerExportRoutes } from './routes/export.ts';
import { githubRoutes } from './routes/github.ts';
import { registerGoalRoutes } from './routes/goals.ts';
import { registerHandoffRoutes } from './routes/handoffs.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerHookRoutes } from './routes/hooks.ts';
import { registerInboxRoutes } from './routes/inbox.ts';
import { registerLaunchRoutes } from './routes/launch.ts';
import { registerLinksRoutes } from './routes/links.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { planRoutes } from './routes/plan.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerPtyRoutes } from './routes/pty.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerRecapRoutes } from './routes/recaps.ts';
import { registerReminderRoutes } from './routes/reminders.ts';
import { registerRemoteRoutes } from './routes/remote.ts';
import { reviewRoutes } from './routes/review.ts';
import { registerSafetyRoutes } from './routes/safety.ts';
import { registerSessionActionRoutes } from './routes/session-actions.ts';
import { registerSessionDetailRoutes } from './routes/session-detail.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerShareRoutes } from './routes/share.ts';
import { shipRoutes } from './routes/ship.ts';
import { registerStreamRoutes } from './routes/streams.ts';
import { registerSupervisorRoutes } from './routes/supervisor.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerUsageRoutes } from './routes/usage.ts';
import { registerViewRoutes } from './routes/views.ts';
import { registerWebAuthnRoutes } from './routes/webauthn.ts';
import { worktreesRoutes } from './routes/worktrees.ts';
import { registerStatic } from './static.ts';
import type { OrcApp, OrcEnv } from './types.ts';

export interface AppOptions {
  ctx: DaemonContext;
  token: string;
  port: () => number;
  webDist?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Remote-access guard deps; `null` or unset marks every request as local (P1 tests only). */
  remote?: RemoteGuardDeps | null;
  /**
   * The Phase 6 instance from `createPhase6`. Only its guard deps are read, as the fallback when
   * `remote` is unset. It registers no routes: the Phase 6 routes are in `registerAllRoutes`.
   */
  phase6?: { guardDeps: RemoteGuardDeps } | null;
}

/**
 * **The single registration path.** Every `/api/*` route the daemon serves is registered here and
 * nowhere else, and `redact-out.test.ts`'s boundary census calls this function directly — so a
 * route added here is automatically accounted for at the redaction boundary, and a route added
 * anywhere else is not accounted for at all.
 *
 * Do NOT add a route-registration hook to `createApp`'s options. A `registerExtra` callback passed
 * from `main.ts` was demonstrated to put an unredacted `/api/brand-new` into the live daemon with
 * the entire suite passing, because the census calls `createApp` without it. The phase 2 routes
 * (live, hooks, inbox, templates, launch, archive, notifications) are registered here too, above
 * the catch-all; their services are set on `ctx` by `startPhase2` and read per request. The phase 6
 * routes (connectors, share, session actions, remote, WebAuthn, push, away) follow the same rule:
 * `createPhase6` sets their services on `ctx`, the handlers read them per request and answer
 * `503 unavailable` while they are unset, and `AppOptions.phase6` only supplies the guard deps.
 * The phase 7 automation routes read `ctx.automations` and `ctx.suggestions` (set by
 * `createPhase7`) per request and answer `409 not_enabled` while they are unset. The AGNC routes
 * also answer `409 not_enabled` while `agnc.enabled` is off.
 */
export function registerAllRoutes(app: OrcApp, ctx: DaemonContext): void {
  registerHealthRoutes(app);
  registerProjectRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerViewRoutes(app, ctx);
  registerPtyRoutes(app, ctx);
  registerLiveRoutes(app, ctx);
  registerHookRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerLaunchRoutes(app, ctx);
  registerArchiveRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSafetyRoutes(app, ctx);
  registerSessionDetailRoutes(app, ctx);
  registerLinksRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerRecapRoutes(app, ctx);
  registerGoalRoutes(app, ctx);
  registerReminderRoutes(app, ctx);
  registerHandoffRoutes(app, ctx);
  registerConnectorRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerSessionActionRoutes(app, ctx);
  registerRemoteRoutes(app, ctx);
  registerWebAuthnRoutes(app, ctx);
  registerPushRoutes(app, ctx);
  registerAwayRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerCompareRoutes(app, ctx);
  registerSupervisorRoutes(app, ctx);
  registerAgncRoutes(app, ctx);
  // Outside `/api`: the AGNC OAuth redirect target, public for GET only (see `PUBLIC_API_PATHS`).
  registerAgncOAuthRoute(app, ctx);
  // Phase 4 sub-apps. Each renders its own §6 error bodies through `redactedApiError` and reads
  // its service off `ctx` per request (set by `wirePhase4`), answering 503 while it is unset.
  app.route('/api', worktreesRoutes(ctx));
  app.route('/api', githubRoutes(ctx));
  app.route('/api', reviewRoutes(ctx));
  app.route('/api', shipRoutes(ctx));
  app.route('/api', planRoutes(ctx));
  // ORDERING CONTRACT: every `/api/*` route must be registered ABOVE this line. This is a
  // catch-all, so anything registered after it is shadowed and answers 404.
  app.all('/api/*', (c) => c.json(apiError('not_found', 'no such route'), 404));
}

export function createApp(o: AppOptions): OrcApp {
  const app: OrcApp = new Hono<OrcEnv>();
  // Error bodies are a response channel like any other, and until now an unmodelled one: the
  // census could only see what a route returns on success. `services/sessions.ts` throws
  // `cwd_missing` with `` `directory ${s.startCwd} no longer exists` `` and `details: { cwd }`,
  // and `startCwd` is precisely the field phase 1 added to `redactSession` because it is
  // transcript-derived — served raw here on any session whose directory was removed, which is a
  // deleted worktree, which is routine. Redacting at this one point rather than at each throw
  // site is the whole point: enumerating every route's possible error bodies is the same
  // "someone must remember" that cost us thirteen fields.
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(redactedApiError(err.code, err.message, err.details), err.status);
    // There is deliberately NO `ZodError` branch. In this runtime a zod v4 `ZodError` is not an
    // `instanceof Error`, and Hono's `handleError` rethrows anything that is not — so a raw
    // ZodError never reaches this handler at all; it escapes the app entirely. The branch that
    // used to sit here was unreachable, which is why reverting it to an unredacted `apiError`
    // failed nothing. Every request-validation path therefore MUST go through `readJson`/
    // `parseWith`, which wrap the issues in a `ServiceError` and land on the branch above (and
    // whose `details` carry attacker-supplied `unrecognized_keys` names — redacted there).
    // `app.test.ts > a thrown ZodError never reaches onError` is the canary if zod changes this.
    if (err instanceof HTTPException) return c.json(redactedApiError('bad_request', err.message), 400);
    o.ctx.log.error({ err }, 'unhandled request error');
    return c.json(apiError('internal', 'internal error'), 500);
  });

  // Runs first and on every path: it decides local vs remote, fully authenticates remote requests
  // and sets `c.var.remote`. The local host/Origin/install-token checks below skip remote ones.
  app.use('*', remoteGuard(o.remote ?? o.phase6?.guardDeps ?? null));
  app.use('/api/*', apiAccessMiddleware(o));
  // The same host, Origin and token checks for the OAuth redirect targets outside `/api`.
  app.use('/oauth/*', apiAccessMiddleware(o));
  app.use('/api/*', auditMiddleware(o.ctx));

  app.get('/bootstrap.js', bootstrapHandler(o));

  registerAllRoutes(app, o.ctx);

  if (o.webDist) registerStatic(app, o.webDist);
  return app;
}
