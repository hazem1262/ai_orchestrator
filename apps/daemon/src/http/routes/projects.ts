import { ProjectPatchSchema } from '@orc/api-contract';
import { compileTicketRegex } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import type { OrcApp } from '../types.ts';

export function registerProjectRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/projects', (c) => c.json(ctx.projects.list()));
  app.get('/api/projects/:id', (c) => {
    const cfg = ctx.projects.get(c.req.param('id'));
    if (!cfg) throw new ServiceError('not_found', 404, 'project not found');
    return c.json(cfg);
  });
  app.patch('/api/projects/:id', async (c) => {
    const patch = await readJson(c, ProjectPatchSchema);
    if (patch.ticketRegex && compileTicketRegex(patch.ticketRegex) === null) {
      throw new ServiceError('validation_failed', 400, 'ticketRegex is not a valid regular expression');
    }
    return c.json(ctx.projects.update(c.req.param('id'), patch));
  });
}
