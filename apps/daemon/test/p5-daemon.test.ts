import { existsSync, readFileSync } from 'node:fs';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemon } from '../src/main.ts';
import { offlinePhase7 } from './fakes/phase7.ts';
import { createTestContext, makeTempHomes, type TempHomes } from './helpers.ts';
import { offlinePhase6 } from './p6-connector-fakes.ts';

/**
 * Phase 5 wired into the real daemon: `createDaemon` + `start` on a temp copy of fixtures/, never
 * the real homes. `createTestContext` writes the config first (`github.enabled: false`, the fake
 * `claude`), recaps stay at their default `enabled: false`, and `ANTHROPIC_API_KEY` is removed for
 * the duration of the test so no LLM engine can be reached.
 */
const saved = {
  CLAUDE_HOME: process.env.CLAUDE_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};
let homes: TempHomes | undefined;

afterEach(() => {
  homes?.cleanup();
  homes = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('phase 5 daemon wiring', () => {
  it('serves every phase 5 route on a real daemon over fixtures', async () => {
    homes = makeTempHomes();
    createTestContext({ homes }).dispose();
    process.env.CLAUDE_HOME = homes.claudeHome;
    process.env.CODEX_HOME = homes.codexHome;
    delete process.env.ANTHROPIC_API_KEY;
    const logLines: Array<Record<string, unknown>> = [];
    const log = pino({ level: 'info' }, { write: (s: string) => void logLines.push(JSON.parse(s)) });
    const daemon = await createDaemon({
      paths: homes.paths,
      log,
      launchExternal: async () => undefined,
      webDist: null,
      phase6: offlinePhase6(),
      phase7: offlinePhase7(),
    });
    const d = await daemon.start({ port: 0, watch: false });
    try {
      expect(daemon.ctx.config().github.enabled).toBe(false);
      expect(daemon.ctx.config().recaps.enabled).toBe(false);
      const token = daemon.ctx.paths.tokenFile;
      const headers = { 'x-orc-token': readFileSync(token, 'utf8').trim() };
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${d.port}${path}`, { headers });
        return { status: res.status, body: (await res.json()) as unknown };
      };
      expect((await get('/api/usage')).status).toBe(200);
      expect((await get('/api/usage/budgets')).status).toBe(200);
      expect((await get('/api/settings')).status).toBe(200);
      expect((await get('/api/streams')).status).toBe(200);
      expect((await get('/api/analytics/cost?groupBy=day')).status).toBe(200);
      expect((await get('/api/analytics/digest')).status).toBe(200);
      expect((await get('/api/goals')).status).toBe(200);
      expect((await get('/api/reminders')).status).toBe(200);
      expect((await get('/api/hooks/install')).status).toBe(200);
      expect((await get('/api/hooks/statusline')).status).toBe(200);
      const unauth = await fetch(`http://127.0.0.1:${d.port}/api/usage`);
      expect(unauth.status).toBe(401);
      // the ledger reads the session index, so the initial scan has to finish before the backfill
      await vi.waitFor(() => expect(logLines.some((l) => l.msg === 'initial index complete')).toBe(true), {
        timeout: 30_000,
        interval: 100,
      });
      // the ledger indexed the fixtures, so analytics answers with real numbers
      await daemon.ctx.ledger?.backfill('2026-01-01T00:00:00.000Z');
      const cost = (await get('/api/analytics/cost?groupBy=source&from=2026-01-01T00:00:00.000Z')).body as {
        rows: Array<{ key: string }>;
      };
      expect(cost.rows.map((r) => r.key).sort()).toContain('claude');
      // nothing was written into the fixture CLAUDE_HOME
      const settings = `${daemon.ctx.paths.claudeHome}/settings.json`;
      const before = existsSync(settings);
      expect((await get('/api/hooks/install')).status).toBe(200);
      expect(existsSync(settings)).toBe(before);
    } finally {
      await d.close();
    }
  }, 60_000);
});
