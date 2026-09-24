import type { HttpBindings } from '@hono/node-server';
import { apiError } from '@orc/api-contract';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DaemonContext } from '../context.ts';
import { ServiceError } from '../services/errors.ts';
import { auditMiddleware } from './audit-middleware.ts';
import { allowedHosts, allowedOrigins, isLoopback, tokenMatches } from './auth.ts';
import { redactedApiError } from './redact-out.ts';
import { registerArchiveRoutes } from './routes/archive.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerHookRoutes } from './routes/hooks.ts';
import { registerInboxRoutes } from './routes/inbox.ts';
import { registerLaunchRoutes } from './routes/launch.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerPtyRoutes } from './routes/pty.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerViewRoutes } from './routes/views.ts';
import { registerStatic } from './static.ts';
import type { OrcApp } from './types.ts';

export interface AppOptions {
  ctx: DaemonContext;
  token: string;
  port: () => number;
  webDist?: string | null;
  env?: NodeJS.ProcessEnv;
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
 * the catch-all; their services are set on `ctx` by `startPhase2` and read per request.
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
  // ORDERING CONTRACT: every `/api/*` route must be registered ABOVE this line. This is a
  // catch-all, so anything registered after it is shadowed and answers 404.
  app.all('/api/*', (c) => c.json(apiError('not_found', 'no such route'), 404));
}

export function createApp(o: AppOptions): OrcApp {
  const app: OrcApp = new Hono<{ Bindings: HttpBindings }>();
  const hostOf = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;
  const hostOk = (c: Context) => allowedHosts(o.port(), o.env).includes(hostOf(c));

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

  app.use('/api/*', async (c, next) => {
    if (!hostOk(c)) return c.json(apiError('forbidden', 'host not allowed'), 403);
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins(o.port(), o.env).includes(origin)) {
      return c.json(apiError('forbidden', 'origin not allowed'), 403);
    }
    if (!tokenMatches(o.token, c.req.header('x-orc-token'))) {
      return c.json(apiError('unauthorized', 'missing or invalid token'), 401);
    }
    await next();
  });
  app.use('/api/*', auditMiddleware(o.ctx));

  app.get('/bootstrap.js', (c) => {
    const remote = c.env?.incoming?.socket?.remoteAddress;
    const site = c.req.header('sec-fetch-site');
    const siteOk = site === undefined || site === 'same-origin' || site === 'none';
    if (!isLoopback(remote) || !hostOk(c) || !siteOk) return c.text('forbidden', 403);
    return c.body(`window.__ORC_TOKEN__ = ${JSON.stringify(o.token)};\n`, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
  });

  registerAllRoutes(app, o.ctx);

  if (o.webDist) registerStatic(app, o.webDist);
  return app;
}
