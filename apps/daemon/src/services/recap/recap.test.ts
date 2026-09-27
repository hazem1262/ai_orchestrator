import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { recordingInbox } from '../../../test/stubs.ts';
import { inboxDedupeKey } from '../../inbox/engine.ts';
import { ServiceError } from '../errors.ts';
import { createScheduler } from '../scheduler/scheduler.ts';
import { type RecapEngine, RecapEngineError } from './engines.ts';
import { createRecapService } from './recap.ts';

// Safety: no test here may run the real `claude` binary or reach the Anthropic API.
// - Every RecapService gets injected fake engines (`engines: { 'claude-cli': fake, 'anthropic-api': fake }`);
//   `defaultRecapEngines` is never called.
// - ANTHROPIC_API_KEY is removed from the process for the whole file.
let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});

const NOW = new Date('2026-09-17T12:00:00.000Z');

// Shipped inbox API (contracts §11): callers pass { kind, scope, facet } and the engine composes the
// dedupe key. The plan's `recap-budget:<yyyy-mm>` maps to scope { domain: 'recap-budget', id: '<yyyy-mm>' }
// — the `domain` scope dedupe-key.ts names for "a quota window".
const recapBudgetKey = (month: string) =>
  inboxDedupeKey({ kind: 'budget', scope: { domain: 'recap-budget', id: month } });

function setup(
  opts: { recaps?: Record<string, unknown>; projectRecaps?: boolean; engineError?: RecapEngineError } = {},
) {
  const s1 = makeSession({
    id: 's1',
    name: 'Fix SLA',
    promptCount: 3,
    lastActivityAt: '2026-09-17T10:00:00.000Z',
    tickets: ['SAF-1'],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 },
  });
  const tiny = makeSession({ id: 'tiny', promptCount: 1, lastActivityAt: '2026-09-17T09:00:00.000Z' });
  const events = {
    'claude:s1': [
      ev({ seq: 1, ts: '2026-09-17T09:00:00.000Z', kind: 'prompt', text: 'fix the SLA weekends' }),
      ev({ seq: 2, ts: '2026-09-17T09:00:05.000Z', kind: 'tool_result', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' }),
    ],
  };
  const t = makeP5Context({
    config: (c) => {
      const w = withWakecap('/Users/test/Wakecap', {
        features: { workStreams: true, prodBadges: true, recaps: opts.projectRecaps ?? true },
      })(c);
      return { ...w, recaps: { ...w.recaps, ...opts.recaps } };
    },
    data: { sessions: [s1, tiny], events },
  });
  const prompts: Array<{ prompt: string; model: string; maxBudgetUsd: number }> = [];
  const engine: RecapEngine = {
    id: 'claude-cli',
    run: vi.fn(async (prompt, o) => {
      prompts.push({ prompt, model: o.model, maxBudgetUsd: o.maxBudgetUsd });
      if (opts.engineError) throw opts.engineError;
      return {
        text: `Recap by ${o.model}\n**Goal:** x`,
        costUsd: 0.25,
        model: o.model,
        engine: 'claude-cli' as const,
      };
    }),
  };
  const inbox = recordingInbox();
  t.ctx.inbox = inbox;
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) });
  const svc = createRecapService(t.ctx, {
    engines: { 'claude-cli': engine, 'anthropic-api': engine },
    scheduler,
    now: () => NOW,
    idleMs: 20,
  });
  return { ...t, svc, engine, prompts, upserts: inbox.upserts, scheduler };
}

describe('recap service', () => {
  it('recaps on demand with the on-demand model, caches, stores and emits', async () => {
    const { svc, engine, prompts, ctx } = setup();
    const updated: Array<string | null> = [];
    ctx.bus.on('session.updated', (e) => void updated.push(e.session.recap));
    const r = await svc.recap('claude:s1', { onDemand: true });
    expect(r).toEqual({
      text: 'Recap by claude-sonnet-5\n**Goal:** x',
      costUsd: 0.25,
      model: 'claude-sonnet-5',
      cached: false,
    });
    expect(prompts[0]?.prompt).toContain('**What to check:**');
    expect(prompts[0]?.prompt).toContain('[turn 1] USER: fix the SLA weekends');
    expect(prompts[0]?.prompt).not.toContain('TOOL_OUTPUT_MUST_NOT_LEAK');
    expect(prompts[0]?.maxBudgetUsd).toBe(20);
    expect(updated).toEqual(['Recap by claude-sonnet-5\n**Goal:** x']);
    expect(await svc.recap('claude:s1', { onDemand: true })).toMatchObject({ cached: true, costUsd: 0.25 });
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(svc.latest('claude:s1')?.model).toBe('claude-sonnet-5');
    expect(svc.monthSpend()).toEqual({ spentUsd: 0.25, budgetUsd: 20 });
  });

  it('enforces the enabled flags, scope and minimum prompts', async () => {
    const off = setup();
    await expect(off.svc.recap('claude:s1')).rejects.toMatchObject({ code: 'recaps_disabled', status: 409 });
    const on = setup({ recaps: { enabled: true } });
    await expect(on.svc.recap('claude:tiny')).rejects.toMatchObject({ code: 'too_small' });
    expect((await on.svc.recap('claude:s1')).model).toBe('claude-haiku-4-5');
    const proj = setup({ projectRecaps: false });
    await expect(proj.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({
      code: 'recaps_disabled',
    });
    const excl = setup({ recaps: { excludeProjectIds: ['wakecap'] } });
    await expect(excl.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({
      code: 'recaps_disabled',
    });
    await expect(off.svc.recap('claude:nope', { onDemand: true })).rejects.toBeInstanceOf(ServiceError);
  });

  it('refuses over budget and opens an inbox item', async () => {
    const { svc, upserts } = setup({ recaps: { monthlyBudgetUsd: 0.2 } });
    await svc.recap('claude:s1', { onDemand: true });
    await expect(svc.recap('claude:tiny', { onDemand: true })).rejects.toMatchObject({ code: 'over_budget' });
    expect(upserts[0]).toMatchObject({ kind: 'budget' });
    expect(upserts[0] && inboxDedupeKey(upserts[0])).toBe(recapBudgetKey('2026-09'));
  });

  it('maps engine errors', async () => {
    const a = setup({ engineError: new RecapEngineError('engine_unavailable', 'x') });
    await expect(a.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({
      code: 'engine_unavailable',
      status: 422,
    });
    const b = setup({ engineError: new RecapEngineError('bad_output', 'x') });
    await expect(b.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({
      code: 'engine_failed',
      status: 500,
    });
  });

  it('uses the custom template and language', async () => {
    const { svc, prompts } = setup({
      recaps: { promptTemplate: 'LANG={{language}} DIGEST={{digest}}', language: 'ar' },
    });
    await svc.recap('claude:s1', { onDemand: true });
    expect(prompts[0]?.prompt.startsWith('LANG=ar DIGEST=# Session')).toBe(true);
  });

  it('writes a daily project recap from the day’s sessions', async () => {
    const { svc, prompts } = setup();
    await svc.recap('claude:s1', { onDemand: true });
    const text = await svc.daily('wakecap', '2026-09-17');
    expect(text).toBe('Recap by claude-haiku-4-5\n**Goal:** x');
    expect(prompts[1]?.prompt).toContain('project wakecap on 2026-09-17');
    expect(prompts[1]?.prompt).toContain('- Fix SLA ($0.50) tickets: SAF-1 — Recap by claude-sonnet-5');
    expect(svc.latestDaily('wakecap', '2026-09-17')?.kind).toBe('daily');
    expect(await svc.daily('wakecap', '2026-09-17')).toBe(text);
    expect(prompts).toHaveLength(2);
    expect(await svc.daily('wakecap', '2020-01-01')).toBe('No sessions on 2020-01-01.');
  });

  it('recaps idle sessions when the trigger is on_idle', async () => {
    const { svc, ctx, engine } = setup({ recaps: { enabled: true, trigger: 'on_idle' } });
    svc.start();
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'idle' });
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1));
    svc.stop();
  });

  it('schedules the daily recap job only for the daily trigger', () => {
    const daily = setup({ recaps: { enabled: true, trigger: 'daily' } });
    daily.svc.syncSchedule();
    expect(daily.scheduler.list('digest').map((j) => j.payload.type)).toEqual(['daily_recap']);
    daily.ctx.updateConfig?.((c) => ({ ...c, recaps: { ...c.recaps, trigger: 'manual' } }));
    daily.svc.syncSchedule();
    expect(daily.scheduler.list('digest')).toEqual([]);
  });
});
