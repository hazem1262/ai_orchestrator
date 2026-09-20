import { SaveViewRequestSchema } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import type { OrcApp } from '../types.ts';

export function registerViewRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/views', (c) => c.json(ctx.userMeta.views()));
  app.post('/api/views', async (c) =>
    c.json(ctx.userMeta.saveView(await readJson(c, SaveViewRequestSchema, { unknownKeyStatus: 422 }))),
  );
  app.delete('/api/views/:id', (c) => {
    if (!ctx.userMeta.deleteView(c.req.param('id')))
      throw new ServiceError('not_found', 404, 'view not found');
    return c.json({ ok: true as const });
  });
}
