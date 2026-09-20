import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { OrcApp } from '../types.ts';

export function registerPtyRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/pty', (c) => c.json(ctx.pty.list()));
  app.delete('/api/pty/:ptyId', async (c) => {
    const id = c.req.param('ptyId');
    const info = ctx.pty.get(id);
    if (!info) throw new ServiceError('not_found', 404, `pty ${id} not found`);
    const body: unknown = await c.req.json().catch(() => null);
    const confirmed =
      typeof body === 'object' && body !== null && (body as { confirm?: unknown }).confirm === true;
    if (!confirmed) {
      throw new ServiceError('confirmation_required', 409, 'confirm to stop this terminal', {
        summary: `Stop \`${[info.command, ...info.args].join(' ')}\` (pid ${info.pid}) in ${info.cwd}`,
      });
    }
    ctx.pty.remove(id);
    return c.json({ ok: true as const });
  });
}
