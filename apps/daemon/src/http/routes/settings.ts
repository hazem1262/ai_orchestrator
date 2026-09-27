import { type OrcConfig, SettingsUpdateBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { readBody } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const sections = (c: OrcConfig) => ({ recaps: c.recaps, limits: c.limits, digest: c.digest, hooks: c.hooks });

export function registerSettingsRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/settings', (c) => c.json(sections(ctx.config())));
  app.put('/api/settings', async (c) => {
    const body = await readBody(c, SettingsUpdateBody);
    if (!body.ok) return body.res;
    const patch = body.data;
    const next = need(
      ctx.updateConfig,
      'updateConfig',
    )((cfg) => ({
      ...cfg,
      recaps: patch.recaps ?? cfg.recaps,
      limits: patch.limits ?? cfg.limits,
      digest: patch.digest ?? cfg.digest,
      hooks: patch.hooks ?? cfg.hooks,
    }));
    return c.json(sections(next));
  });
}
