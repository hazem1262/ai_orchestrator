import { CORE_VERSION } from '@orc/core';
import type { OrcApp } from '../types.ts';

const startedAt = Date.now();

export function registerHealthRoutes(app: OrcApp): void {
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: CORE_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );
}
