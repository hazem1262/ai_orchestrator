import { ProjectPatchSchema } from '@orc/api-contract';
import { compileTicketRegex } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { redactProject } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

export function registerProjectRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/projects', (c) => c.json(ctx.projects.list().map(redactProject)));
  // NOT redacted, unlike the list above, and the exception is deliberate: this is the settings
  // editor's round-trip payload. The client GETs it, edits one field and PATCHes the whole thing
  // back, so a redaction tag here would be written into the user's own `config.json` as the new
  // `pathPrefixes` value and silently unbind the project from its directories. These values are
  // user-authored config, not transcript-derived. Declared in `redact-out.test.ts`'s census.
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
