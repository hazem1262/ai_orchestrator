import { AwayBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import type { AwayService } from '../../remote/away.ts';
import { readJson } from '../json.ts';
import { need, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

/**
 * Read and set away mode. Remote devices may set it (route policy `device`). Registered from
 * `registerAllRoutes` with no `deps`: the service is then read off `ctx.away` per request (503
 * while unwired).
 */
export function registerAwayRoutes(app: OrcApp, ctx: DaemonContext, deps?: { away: AwayService }): void {
  const away = () => deps?.away ?? need(ctx.away, 'away');
  app.get('/api/remote/away', (c) => c.json(away().state()));

  app.post('/api/remote/away', async (c) => {
    const { mode } = await readJson(c, AwayBody);
    const state = await away().setMode(mode);
    ctx.audit.record({
      ...whoOf(c),
      action: 'away.set',
      target: null,
      params: { mode, away: state.away },
      result: 'ok',
      error: null,
    });
    return c.json(state);
  });
}
