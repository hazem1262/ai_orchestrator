import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { p6TestApp, send } from '../../test/p6-app.ts';
import { makeInboxItem, p6Context } from '../../test/p6-fakes.ts';
import { registerAwayRoutes } from '../http/routes/away.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { createEventBus } from '../live/event-bus.ts';
import { createNotifier, type NotifyChannelImpl } from '../notify/notifier.ts';
import { selectChannels } from '../notify/routing.ts';
import { createAwayService } from './away.ts';
import { parseHidIdleSeconds, readIdleSeconds } from './idle.ts';

const IOREG = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 20>
    {
      "HIDIdleTime" = 754000000000
      "HIDParameters" = {"HIDDefaultParameters"=Yes}
    }
`;

describe('idle detection', () => {
  it('parses HIDIdleTime nanoseconds', () => {
    expect(parseHidIdleSeconds(IOREG)).toBe(754);
    expect(parseHidIdleSeconds('no idle here')).toBeNull();
  });

  it('runs ioreg only on macOS and survives failures', async () => {
    const run = vi.fn(async () => IOREG);
    expect(await readIdleSeconds({ run, platform: 'darwin' })).toBe(754);
    expect(run).toHaveBeenCalledWith('ioreg', ['-c', 'IOHIDSystem']);
    expect(await readIdleSeconds({ run, platform: 'linux' })).toBeNull();
    expect(
      await readIdleSeconds({
        run: async () => {
          throw new Error('ENOENT');
        },
        platform: 'darwin',
      }),
    ).toBeNull();
  });
});

describe('routing', () => {
  it('swaps macOS for the away channels while away', () => {
    const pref = { enabled: true, channels: ['macos' as const] };
    expect(selectChannels({ pref, away: false, awayChannels: ['webpush', 'slack_dm'] })).toEqual(['macos']);
    expect(selectChannels({ pref, away: true, awayChannels: ['webpush', 'slack_dm'] })).toEqual([
      'webpush',
      'slack_dm',
    ]);
    expect(
      selectChannels({
        pref: { enabled: true, channels: ['macos', 'webpush'] },
        away: true,
        awayChannels: ['slack_dm'],
      }),
    ).toEqual(['webpush', 'slack_dm']);
    expect(
      selectChannels({
        pref: { enabled: false, channels: ['macos'] },
        away: true,
        awayChannels: ['webpush'],
      }),
    ).toEqual([]);
  });

  it('routes P2 notifier deliveries through the away channels', async () => {
    const cfg = OrcConfig.parse({ away: { channels: ['webpush'] } });
    const n = createNotifier({ config: () => cfg, debounceMs: 0 });
    const sent: string[] = [];
    const ch = (id: NotifyChannelImpl['id']): NotifyChannelImpl => ({
      id,
      send: async () => {
        sent.push(id);
      },
    });
    n.register(ch('macos'));
    n.register(ch('webpush'));
    n.register(ch('slack_dm'));
    await n.notify(makeInboxItem({ id: 'a', dedupeKey: 'waiting:claude:a' }));
    n.setAway(true);
    await n.notify(makeInboxItem({ id: 'b', dedupeKey: 'waiting:claude:b' }));
    expect(sent).toEqual(['macos', 'webpush']);
  });
});

describe('away service', () => {
  it('follows idle time in auto mode and manual overrides', async () => {
    let idle: number | null = 30;
    const cfg = OrcConfig.parse({ away: { idleMinutes: 10 } });
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.on('away.changed', (e) => events.push(e));
    const setAway = vi.fn();
    const away = createAwayService({
      config: () => cfg,
      notifier: { notify: async () => {}, register: () => {}, setAway, isAway: () => false },
      bus,
      idle: async () => idle,
    });
    expect(await away.tick()).toEqual({ away: false, mode: 'auto', reason: 'present', idleSeconds: 30 });
    idle = 600;
    expect((await away.tick()).away).toBe(true);
    expect(await away.setMode('off')).toMatchObject({ away: false, reason: 'manual' });
    expect(await away.setMode('on')).toMatchObject({ away: true, reason: 'manual' });
    idle = null;
    expect(await away.setMode('auto')).toMatchObject({ away: false, reason: 'present', idleSeconds: null });
    expect(setAway.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(events.map((e) => (e.type === 'away.changed' ? `${e.away}:${e.reason}` : ''))).toEqual([
      'true:idle',
      'false:manual',
      'true:manual',
      'false:present',
    ]);
  });
});

describe('away routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  it('reads and sets the mode, audited', async () => {
    const { ctx, audit, notifier } = p6Context();
    cleanups.push(() => ctx.dispose());
    const away = createAwayService({ config: ctx.config, notifier, bus: ctx.bus, idle: async () => 0 });
    const app = p6TestApp();
    registerAwayRoutes(app, ctx, { away });
    expect(await (await send(app, 'GET', '/api/remote/away')).json()).toMatchObject({
      away: false,
      mode: 'auto',
    });
    const res = await send(app, 'POST', '/api/remote/away', { mode: 'on' }, { 'x-test-remote': 'd1' });
    expect(await res.json()).toMatchObject({ away: true, mode: 'on' });
    expect(notifier.isAway()).toBe(true);
    expect(audit.list({ action: 'away.set' })[0]).toMatchObject({ actor: 'remote', params: { mode: 'on' } });
    expect((await send(app, 'POST', '/api/remote/away', { mode: 'sometimes' })).status).toBe(400);
  });
});
