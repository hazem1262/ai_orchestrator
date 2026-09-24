import { DenyCheckRequest } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { createSecretsScanner } from '../../services/safety/secrets-scan.ts';
import { redactedApiError } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

export function registerSafetyRoutes(app: OrcApp, ctx: DaemonContext, opts: { home?: string } = {}): void {
  const scanner = createSecretsScanner({ config: ctx.config, home: opts.home });

  app.get('/api/safety/secrets', async (c) => c.json(await scanner.scan()));

  app.post('/api/safety/deny-check', async (c) => {
    const parsed = DenyCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        redactedApiError('validation_failed', 'invalid deny-check body', parsed.error.issues),
        400,
      );
    }
    return c.json(ctx.denyList.check(parsed.data.text, parsed.data.projectId));
  });
}
