import { describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import type { BusEvent } from '../../live/event-bus.ts';
import { registerHookRoutes } from './hooks.ts';

function setup() {
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  const live = createFakeLive();
  ctx.live = live;
  const events: BusEvent[] = [];
  ctx.bus.on('hook.received', (e) => void events.push(e));
  const app = bareApp();
  registerHookRoutes(app, ctx);
  const post = (body: string) =>
    app.request('/api/hooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return { live, events, post };
}

describe('POST /api/hooks (bridge)', () => {
  it('maps the five bridge events and forwards the tool, dropping everything else', async () => {
    const { live, events, post } = setup();
    const res = await post(
      JSON.stringify({
        session_id: 's-basic',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'SECRET' },
      }),
    );
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    for (const ev of ['SessionStart', 'PostToolUse', 'Notification', 'Stop']) {
      await post(JSON.stringify({ session_id: 's-basic', hook_event_name: ev }));
    }
    expect(live.hooks.map((h) => [h.event, h.tool ?? null])).toEqual([
      ['PreToolUse', 'Bash'],
      ['SessionStart', null],
      ['PostToolUse', null],
      ['Notification', null],
      ['Stop', null],
    ]);
    expect(JSON.stringify(live.hooks)).not.toContain('SECRET');
    expect(events[0]).toEqual({
      type: 'hook.received',
      payload: { sessionId: 's-basic', event: 'PreToolUse' },
    });
  });

  it('accepts unknown events without applying them and rejects bad or huge bodies', async () => {
    const { live, post } = setup();
    expect(
      await (await post(JSON.stringify({ session_id: 's', hook_event_name: 'PreCompact' }))).json(),
    ).toEqual({
      ok: true,
      accepted: false,
    });
    expect(live.hooks).toHaveLength(1); // P2 forwards every valid event; the tracker ignores unknown ones
    const bad = await post(
      '{"hook_event_name":"Stop","prompt":"export ORC_FAKE_TOKEN=placeholder-not-real"}',
    );
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('placeholder-not-real');
    expect(
      (await post(JSON.stringify({ session_id: 's', hook_event_name: 'Stop', pad: 'x'.repeat(300 * 1024) })))
        .status,
    ).toBe(413);
  });

  it('requires the token through the real app', async () => {
    const t = await createP3Harness();
    try {
      const res = await t.app.request('http://127.0.0.1:4317/api/hooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }),
      });
      expect(res.status).toBe(401);
      expect(
        (
          await t.request('/api/hooks', {
            method: 'POST',
            body: { session_id: 's', hook_event_name: 'Stop' },
          })
        ).status,
      ).toBe(200);
    } finally {
      await t.cleanup();
    }
  });
});
