import type { HttpBindings } from '@hono/node-server';
import { apiError } from '@orc/api-contract';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { DaemonContext } from '../context.ts';
import { ServiceError } from '../services/errors.ts';
import { allowedHosts, allowedOrigins, isLoopback, tokenMatches } from './auth.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerPtyRoutes } from './routes/pty.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
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

export function createApp(o: AppOptions): OrcApp {
  const app: OrcApp = new Hono<{ Bindings: HttpBindings }>();
  const hostOf = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;
  const hostOk = (c: Context) => allowedHosts(o.port(), o.env).includes(hostOf(c));

  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(apiError(err.code, err.message, err.details), err.status);
    if (err instanceof ZodError)
      return c.json(apiError('validation_failed', 'invalid request', err.issues), 400);
    if (err instanceof HTTPException) return c.json(apiError('bad_request', err.message), 400);
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

  registerHealthRoutes(app);
  registerProjectRoutes(app, o.ctx);
  registerSessionRoutes(app, o.ctx);
  registerViewRoutes(app, o.ctx);
  registerPtyRoutes(app, o.ctx);
  app.all('/api/*', (c) => c.json(apiError('not_found', 'no such route'), 404));

  if (o.webDist) registerStatic(app, o.webDist);
  return app;
}
