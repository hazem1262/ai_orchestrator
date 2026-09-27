import { AwayBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import type { AwayService } from '../../remote/away.ts';
import { readJson } from '../json.ts';
import { whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

/**
 * Read and set away mode. Remote devices may set it (route policy `device`). Not mounted by
 * `registerAllRoutes` yet: Task 20's `createPhase6().register` mounts it with the other Phase 6
 * routes.
 */
export function registerAwayRoutes(app: OrcApp, ctx: DaemonContext, d: { away: AwayService }): void {
  app.get('/api/remote/away', (c) => c.json(d.away.state()));

  app.post('/api/remote/away', async (c) => {
    const { mode } = await readJson(c, AwayBody);
    const state = await d.away.setMode(mode);
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
