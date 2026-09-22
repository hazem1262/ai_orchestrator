import { OrcConfig } from '@orc/api-contract';
import type { InboxItem, InboxKind } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { inboxDedupeKey } from '../inbox/dedupe-key.ts';
import { createMacosChannel, KIND_TITLE, type NodeNotifierLike } from './macos.ts';
import {
  createNotifier,
  DEFAULT_NOTIFY_PREFS,
  type NotifyChannel,
  type NotifyChannelImpl,
  notificationUrl,
  prefFor,
} from './notifier.ts';

const ALL_KINDS: InboxKind[] = [
  'waiting',
  'review',
  'plan_approval',
  'blocked',
  'error',
  'tests_red',
  'budget',
  'automation_result',
  'supervisor_escalation',
  'pr_event',
  'reminder',
];
const DEFAULT_ON: InboxKind[] = ['waiting', 'review', 'error', 'tests_red', 'plan_approval', 'blocked'];
const DEFAULT_OFF = ALL_KINDS.filter((k) => !DEFAULT_ON.includes(k));

/** A session-scoped key, composed the only way the daemon composes one. */
const keyFor = (kind: InboxKind, sessionPk: string) =>
  inboxDedupeKey({ kind, scope: { session: sessionPk } });

const item = (over: Partial<InboxItem> = {}): InboxItem => {
  const kind = over.kind ?? 'waiting';
  return {
    id: 'i1',
    kind,
    sessionId: 's-basic',
    projectId: 'wakecap',
    ticket: null,
    reason: 'Waiting',
    dedupeKey: keyFor(kind, 'claude:s-basic'),
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    state: 'open',
    snoozeUntil: null,
    payload: { source: 'claude', id: 's-basic' },
    ...over,
  };
};

/** An item about a different session than the default fixture: different pk, different key. */
const otherSession = (over: Partial<InboxItem> = {}): InboxItem =>
  item({
    id: 'i-other',
    sessionId: 's-other',
    dedupeKey: keyFor(over.kind ?? 'waiting', 'claude:s-other'),
    payload: { source: 'claude', id: 's-other' },
    ...over,
  });

type SendFn = NotifyChannelImpl['send'];

function setup(cfgInput: unknown = {}, channelIds: NotifyChannel[] = ['macos']) {
  let now = 0;
  let cfg = OrcConfig.parse(cfgInput);
  const sends = new Map<NotifyChannel, ReturnType<typeof vi.fn<SendFn>>>();
  const warn = vi.fn();
  const n = createNotifier({ config: () => cfg, log: { warn }, now: () => now, debounceMs: 30_000 });
  for (const id of channelIds) {
    const send = vi.fn<SendFn>(async () => {});
    sends.set(id, send);
    n.register({ id, send });
  }
  const send = sends.get(channelIds[0] ?? 'macos') as ReturnType<typeof vi.fn<SendFn>>;
  return {
    n,
    send,
    sendOf: (id: NotifyChannel) => sends.get(id) as ReturnType<typeof vi.fn<SendFn>>,
    warn,
    tick: (ms: number) => {
      now += ms;
    },
    setConfig: (input: unknown) => {
      cfg = OrcConfig.parse(input);
    },
  };
}

describe('fixture keys', () => {
  it('compose to distinct keys for distinct sessions, so the debounce tests below test something', () => {
    expect(item().dedupeKey).not.toBe(otherSession().dedupeKey);
    expect(item({ kind: 'review' }).dedupeKey).not.toBe(item().dedupeKey);
  });
});

describe('notificationUrl', () => {
  it('links to the session from payload.source and payload.id', () => {
    expect(notificationUrl(item(), 4317)).toBe('http://127.0.0.1:4317/sessions/claude/s-basic');
    expect(notificationUrl(item({ payload: { source: 'codex', id: 'rollout-7' } }), 4317)).toBe(
      'http://127.0.0.1:4317/sessions/codex/rollout-7',
    );
  });

  it('uses the port it is given', () => {
    expect(notificationUrl(item(), 5555)).toBe('http://127.0.0.1:5555/sessions/claude/s-basic');
  });

  it('encodes a source and an id containing a slash or a space', () => {
    expect(notificationUrl(item({ payload: { source: 'my src/x', id: 'a/b c' } }), 4317)).toBe(
      'http://127.0.0.1:4317/sessions/my%20src%2Fx/a%2Fb%20c',
    );
  });

  it('links to /inbox when the item has no session', () => {
    expect(notificationUrl(item({ sessionId: null, payload: {} }), 4317)).toBe('http://127.0.0.1:4317/inbox');
  });
});

describe('prefFor / DEFAULT_NOTIFY_PREFS', () => {
  it.each(DEFAULT_ON)('defaults %s to on, via macOS', (kind) => {
    const cfg = OrcConfig.parse({});
    expect(prefFor(cfg, kind)).toEqual({ enabled: true, channels: ['macos'] });
    expect(DEFAULT_NOTIFY_PREFS[kind]).toEqual({ enabled: true, channels: ['macos'] });
  });

  it.each(DEFAULT_OFF)('defaults %s to off', (kind) => {
    const cfg = OrcConfig.parse({});
    expect(prefFor(cfg, kind).enabled).toBe(false);
  });

  it('lets config switch a default-on kind off', () => {
    const cfg = OrcConfig.parse({ notifications: { waiting: { enabled: false, channels: ['macos'] } } });
    expect(prefFor(cfg, 'waiting')).toEqual({ enabled: false, channels: ['macos'] });
  });

  it('lets config switch a default-off kind on, with its own channels', () => {
    const cfg = OrcConfig.parse({ notifications: { reminder: { enabled: true, channels: ['webpush'] } } });
    expect(prefFor(cfg, 'reminder')).toEqual({ enabled: true, channels: ['webpush'] });
  });
});

describe('createNotifier — preferences', () => {
  it('sends an enabled kind to its channel with the click URL', async () => {
    const { n, send } = setup();
    await n.notify(item());
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(item(), 'http://127.0.0.1:4317/sessions/claude/s-basic');
  });

  it('builds the click URL from config.port', async () => {
    const { n, send } = setup({ port: 5555 });
    await n.notify(item());
    expect(send).toHaveBeenCalledWith(item(), 'http://127.0.0.1:5555/sessions/claude/s-basic');
  });

  it('sends /inbox as the click URL for an item with no session', async () => {
    const { n, send } = setup();
    const global = item({
      sessionId: null,
      payload: {},
      dedupeKey: inboxDedupeKey({ kind: 'waiting', scope: { global: true } }),
    });
    await n.notify(global);
    expect(send).toHaveBeenCalledWith(global, 'http://127.0.0.1:4317/inbox');
  });

  it.each(DEFAULT_ON)('notifies %s with no config', async (kind) => {
    const { n, send } = setup();
    await n.notify(item({ kind }));
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(DEFAULT_OFF)('does not notify %s with no config', async (kind) => {
    const { n, send } = setup();
    await n.notify(item({ kind }));
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a kind config disabled', async () => {
    const { n, send } = setup({ notifications: { waiting: { enabled: false, channels: ['macos'] } } });
    await n.notify(item());
    expect(send).not.toHaveBeenCalled();
  });

  it('notifies a default-off kind config enabled', async () => {
    const { n, send } = setup({ notifications: { reminder: { enabled: true, channels: ['macos'] } } });
    await n.notify(item({ kind: 'reminder' }));
    expect(send).toHaveBeenCalledOnce();
  });

  it('sends only to the channels config lists', async () => {
    const { n, sendOf } = setup({ notifications: { waiting: { enabled: true, channels: ['webpush'] } } }, [
      'macos',
      'webpush',
    ]);
    await n.notify(item());
    expect(sendOf('webpush')).toHaveBeenCalledOnce();
    expect(sendOf('macos')).not.toHaveBeenCalled();
  });

  it('reads config on every notify, not once at creation', async () => {
    const { n, send, setConfig } = setup();
    setConfig({ notifications: { waiting: { enabled: false, channels: ['macos'] } } });
    await n.notify(item());
    expect(send).not.toHaveBeenCalled();
  });
});

describe('createNotifier — debounce per dedupeKey', () => {
  it('notifies two different sessions within the window — one session never silences another', async () => {
    const { n, send, tick } = setup();
    await n.notify(item());
    tick(1_000);
    await n.notify(otherSession());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([i]) => i.dedupeKey)).toEqual([item().dedupeKey, otherSession().dedupeKey]);
  });

  it('notifies two different kinds for one session within the window', async () => {
    const { n, send } = setup();
    await n.notify(item());
    await n.notify(item({ id: 'i2', kind: 'review' }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('notifies the same key once within the window, even as a new inbox item', async () => {
    const { n, send, tick } = setup();
    await n.notify(item());
    tick(10_000);
    await n.notify(item({ id: 'i2' }));
    tick(19_999);
    await n.notify(item({ id: 'i3' }));
    expect(send).toHaveBeenCalledOnce();
  });

  it('notifies the same key again once the window has passed since the last send', async () => {
    const { n, send, tick } = setup();
    await n.notify(item());
    tick(10_000);
    await n.notify(item({ id: 'i2' })); // suppressed; must not restart the window
    tick(20_000);
    await n.notify(item({ id: 'i3' }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].id).toBe('i3');
  });

  it('defaults the window to 30 seconds', async () => {
    let now = 0;
    const send = vi.fn<SendFn>(async () => {});
    const n = createNotifier({ config: () => OrcConfig.parse({}), now: () => now });
    n.register({ id: 'macos', send });
    await n.notify(item());
    now = 29_999;
    await n.notify(item({ id: 'i2' }));
    expect(send).toHaveBeenCalledOnce();
    now = 30_000;
    await n.notify(item({ id: 'i3' }));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('createNotifier — debounce while a send is in flight', () => {
  it('suppresses a same-key notify that arrives before the first send resolves', async () => {
    const { n, send } = setup();
    let resolve!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const first = n.notify(item());
    await n.notify(item({ id: 'i2' }));
    resolve();
    await first;
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('createNotifier — an undelivered notify leaves the key free', () => {
  it('re-notifies the same key after every channel failed', async () => {
    const { n, send } = setup();
    send.mockRejectedValueOnce(new Error('denied'));
    await n.notify(item());
    await n.notify(item({ id: 'i2' }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('re-notifies the same key after away mode skipped every channel', async () => {
    const { n, send } = setup();
    n.setAway(true);
    await n.notify(item());
    n.setAway(false);
    await n.notify(item({ id: 'i2' }));
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('createNotifier — debounce map eviction', () => {
  it('drops the oldest key past 2000 entries, not a key sent recently', async () => {
    const { n, send, tick } = setup();
    const k = (i: number) => otherSession({ id: `i-${i}`, dedupeKey: keyFor('waiting', `claude:s-${i}`) });
    await n.notify(item());
    tick(30_000);
    for (let i = 1; i < 2000; i += 1) await n.notify(k(i));
    await n.notify(item({ id: 'i-live' })); // window passed: sends and becomes the newest entry
    await n.notify(k(2000)); // entry 2001 evicts the oldest, which is k(1)
    send.mockClear();
    await n.notify(k(1));
    expect(send).toHaveBeenCalledOnce();
    await n.notify(item({ id: 'i-again' }));
    await n.notify(k(2000));
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('createNotifier — away mode', () => {
  it('reports the away flag', () => {
    const { n } = setup();
    expect(n.isAway()).toBe(false);
    n.setAway(true);
    expect(n.isAway()).toBe(true);
    n.setAway(false);
    expect(n.isAway()).toBe(false);
  });

  it('suppresses macOS while away and still delivers to the other channels', async () => {
    const { n, sendOf } = setup(
      { notifications: { review: { enabled: true, channels: ['macos', 'webpush'] } } },
      ['macos', 'webpush'],
    );
    n.setAway(true);
    await n.notify(item({ kind: 'review' }));
    expect(sendOf('macos')).not.toHaveBeenCalled();
    expect(sendOf('webpush')).toHaveBeenCalledOnce();
  });

  it('delivers to macOS again after away is switched off', async () => {
    const { n, send } = setup();
    n.setAway(true);
    await n.notify(item());
    expect(send).not.toHaveBeenCalled();
    n.setAway(false);
    await n.notify(otherSession());
    expect(send).toHaveBeenCalledOnce();
  });

  it('ignores a configured channel that nobody registered', async () => {
    const { n, send, warn } = setup({
      notifications: { review: { enabled: true, channels: ['webpush', 'macos'] } },
    });
    await n.notify(item({ kind: 'review' }));
    expect(send).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createNotifier — channel failures', () => {
  it('logs a rejected channel without throwing', async () => {
    const { n, send, warn } = setup();
    send.mockRejectedValueOnce(new Error('denied'));
    await expect(n.notify(item())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ channel: 'macos' });
  });

  it('logs a channel that throws synchronously without throwing', async () => {
    const { n, send, warn } = setup();
    send.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(n.notify(item())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('still delivers to the next channel when one fails', async () => {
    const { n, sendOf, warn } = setup(
      { notifications: { waiting: { enabled: true, channels: ['macos', 'webpush'] } } },
      ['macos', 'webpush'],
    );
    sendOf('macos').mockRejectedValueOnce(new Error('denied'));
    await n.notify(item());
    expect(sendOf('webpush')).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('works with no logger', async () => {
    const send = vi.fn<SendFn>(async () => {
      throw new Error('denied');
    });
    const n = createNotifier({ config: () => OrcConfig.parse({}) });
    n.register({ id: 'macos', send });
    await expect(n.notify(item())).resolves.toBeUndefined();
  });
});

describe('createMacosChannel', () => {
  it('has the macos id', () => {
    expect(createMacosChannel({ impl: { notify: vi.fn() }, platform: 'darwin' }).id).toBe('macos');
  });

  it.each(['linux', 'win32'] as const)('does nothing on %s', async (platform) => {
    const impl: NodeNotifierLike = { notify: vi.fn() };
    await expect(createMacosChannel({ impl, platform }).send(item(), 'http://x')).resolves.toBeUndefined();
    expect(impl.notify).not.toHaveBeenCalled();
  });

  it('posts a grouped notification that opens the URL', async () => {
    const notify = vi.fn((_o: Parameters<NodeNotifierLike['notify']>[0], cb?: (err: Error | null) => void) =>
      cb?.(null),
    );
    const it1 = item({ reason: 'SLA: waiting — input needed' });
    await createMacosChannel({ impl: { notify }, platform: 'darwin' }).send(
      it1,
      'http://127.0.0.1:4317/sessions/claude/s-basic',
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toEqual({
      title: 'Orchestrator · Waiting for you',
      message: 'SLA: waiting — input needed',
      open: 'http://127.0.0.1:4317/sessions/claude/s-basic',
      sound: true,
      wait: false,
      group: it1.dedupeKey,
    });
  });

  it('plays a sound only for waiting', async () => {
    const notify = vi.fn((_o: Parameters<NodeNotifierLike['notify']>[0], cb?: (err: Error | null) => void) =>
      cb?.(null),
    );
    await createMacosChannel({ impl: { notify }, platform: 'darwin' }).send(item({ kind: 'review' }), 'u');
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      title: 'Orchestrator · Ready for review',
      sound: false,
    });
  });

  it('has a title for every inbox kind', () => {
    for (const kind of ALL_KINDS) expect(KIND_TITLE[kind]).toMatch(/\S/);
  });

  it('rejects when node-notifier reports an error', async () => {
    const impl: NodeNotifierLike = { notify: (_o, cb) => cb?.(new Error('no permission')) };
    await expect(createMacosChannel({ impl, platform: 'darwin' }).send(item(), 'u')).rejects.toThrow(
      'no permission',
    );
  });
});
