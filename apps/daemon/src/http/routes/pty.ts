import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { redactPtyInfo } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

export function registerPtyRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/pty', (c) => c.json(ctx.pty.list().map(redactPtyInfo)));
  app.delete('/api/pty/:ptyId', async (c) => {
    const id = c.req.param('ptyId');
    const info = ctx.pty.get(id);
    if (!info) throw new ServiceError('not_found', 404, `pty ${id} not found`);
    const body: unknown = await c.req.json().catch(() => null);
    const confirmed =
      typeof body === 'object' && body !== null && (body as { confirm?: unknown }).confirm === true;
    if (!confirmed) {
      // Built from the redacted view, not the raw one: this summary embeds the full command line
      // and cwd verbatim, so it is a second copy of the same argv the list route serves.
      const safe = redactPtyInfo(info);
      throw new ServiceError('confirmation_required', 409, 'confirm to stop this terminal', {
        summary: `Stop \`${[safe.command, ...safe.args].join(' ')}\` (pid ${safe.pid}) in ${safe.cwd}`,
      });
    }
    ctx.pty.remove(id);
    return c.json({ ok: true as const });
  });
}
