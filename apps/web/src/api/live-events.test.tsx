import type { LiveEvent } from '@orc/api-contract';
import type { InboxItem, Session } from '@orc/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inboxItemFixture, liveSessionFixture, sessionFixture } from '../test/factories.ts';
import { makeQueryClient, queryWrapper } from '../test/query.tsx';
import { applyLiveEvent, liveWsUrl, pkOf, useLiveEvents } from './live-events.ts';
import { inboxKey } from './queries/inbox.ts';
import { liveKey } from './queries/live.ts';

afterEach(() => {
  vi.useRealTimers();
  delete window.__ORC_TOKEN__;
});

const ids = (qc: ReturnType<typeof makeQueryClient>) =>
  (qc.getQueryData<Session[]>(liveKey) ?? []).map((s) => s.id);

describe('pkOf', () => {
  it('matches the daemon pk format source:id', () => {
    expect(pkOf({ source: 'codex', id: 'abc' })).toBe('codex:abc');
  });
});

describe('applyLiveEvent', () => {
  it('replaces a live session in place and appends a new live one', () => {
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, [liveSessionFixture({ id: 'a' }), liveSessionFixture({ id: 'b' })]);
    applyLiveEvent(qc, {
      type: 'session.updated',
      session: liveSessionFixture({ id: 'a' }, { status: 'waiting' }),
    });
    applyLiveEvent(qc, { type: 'session.updated', session: liveSessionFixture({ id: 'c' }) });
    const live = qc.getQueryData<Session[]>(liveKey) ?? [];
    expect(live.map((s) => [s.id, s.live?.status])).toEqual([
      ['a', 'waiting'],
      ['b', 'busy'],
      ['c', 'busy'],
    ]);
  });

  it('removes a session whose live becomes null, and on session.removed by pk', () => {
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, [
      liveSessionFixture({ id: 'a' }),
      liveSessionFixture({ id: 'b' }),
      liveSessionFixture({ id: 'c' }),
    ]);
    applyLiveEvent(qc, { type: 'session.updated', session: sessionFixture({ id: 'b', live: null }) });
    applyLiveEvent(qc, { type: 'session.removed', pk: 'claude:c' });
    expect(ids(qc)).toEqual(['a']);
  });

  it('keys sessions by source as well as id', () => {
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, [liveSessionFixture({ id: 'a' })]);
    applyLiveEvent(qc, {
      type: 'session.updated',
      session: liveSessionFixture({ id: 'a', source: 'codex' }),
    });
    applyLiveEvent(qc, { type: 'session.removed', pk: 'codex:a' });
    const live = qc.getQueryData<Session[]>(liveKey) ?? [];
    expect(live.map((s) => pkOf(s))).toEqual(['claude:a']);
  });

  it('does not add a non-live session to the board', () => {
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, []);
    applyLiveEvent(qc, { type: 'session.updated', session: sessionFixture({ id: 'z', live: null }) });
    expect(ids(qc)).toEqual([]);
  });

  it('does not create the live cache before it was fetched', () => {
    const qc = makeQueryClient();
    applyLiveEvent(qc, { type: 'session.updated', session: liveSessionFixture({ id: 'a' }) });
    expect(qc.getQueryData(liveKey)).toBeUndefined();
  });

  it('merges into a cached session detail and leaves an uncached one alone', () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session', 'claude', 'a'], sessionFixture({ id: 'a', name: 'old' }));
    applyLiveEvent(qc, {
      type: 'session.updated',
      session: liveSessionFixture({ id: 'a', name: 'new' }, { status: 'review' }),
    });
    applyLiveEvent(qc, { type: 'session.updated', session: liveSessionFixture({ id: 'b' }) });
    expect(qc.getQueryData<Session>(['session', 'claude', 'a'])).toMatchObject({
      name: 'new',
      live: { status: 'review' },
    });
    expect(qc.getQueryData(['session', 'claude', 'b'])).toBeUndefined();
  });

  it('moves inbox items between every filtered inbox cache', () => {
    const qc = makeQueryClient();
    qc.setQueryData(inboxKey({ state: ['open'] }), [inboxItemFixture({ id: 'x' })]);
    qc.setQueryData(inboxKey({ state: ['done'] }), []);
    qc.setQueryData(inboxKey({ state: ['open'], projectId: 'forza' }), []);
    applyLiveEvent(qc, {
      type: 'inbox.upserted',
      item: inboxItemFixture({ id: 'y', updatedAt: '2026-09-01T10:00:00.000Z' }),
    });
    const open = () => qc.getQueryData<InboxItem[]>(inboxKey({ state: ['open'] }))?.map((i) => i.id);
    expect(open()).toEqual(['y', 'x']);
    expect(qc.getQueryData<InboxItem[]>(inboxKey({ state: ['open'], projectId: 'forza' }))).toEqual([]);
    applyLiveEvent(qc, {
      type: 'inbox.upserted',
      item: inboxItemFixture({ id: 'x', state: 'done', updatedAt: '2026-09-01T11:00:00.000Z' }),
    });
    expect(open()).toEqual(['y']);
    expect(qc.getQueryData<InboxItem[]>(inboxKey({ state: ['done'] }))?.map((i) => i.id)).toEqual(['x']);
  });

  it('replaces an existing inbox item instead of duplicating it', () => {
    const qc = makeQueryClient();
    qc.setQueryData(inboxKey({}), [inboxItemFixture({ id: 'x', reason: 'old' })]);
    applyLiveEvent(qc, { type: 'inbox.upserted', item: inboxItemFixture({ id: 'x', reason: 'new' }) });
    expect(qc.getQueryData<InboxItem[]>(inboxKey({}))?.map((i) => i.reason)).toEqual(['new']);
  });

  it('invalidates live and inbox on hello, so a reconnect resyncs', () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyLiveEvent(qc, { type: 'hello', serverTime: '2026-09-01T09:00:00.000Z' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['live'] }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['inbox'] }));
  });

  it('invalidates live on pty.exited', () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyLiveEvent(qc, { type: 'pty.exited', ptyId: 'p1', code: 0 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['live'] }));
  });

  it('ignores index.progress and usage.updated without touching the live cache', () => {
    const qc = makeQueryClient();
    const before = [liveSessionFixture({ id: 'a' })];
    qc.setQueryData(liveKey, before);
    const events: LiveEvent[] = [
      { type: 'index.progress', done: 1, total: 2 },
      { type: 'usage.updated', snapshot: { anything: 1 } },
    ];
    for (const e of events) expect(() => applyLiveEvent(qc, e)).not.toThrow();
    expect(qc.getQueryData(liveKey)).toBe(before);
  });
});

describe('liveWsUrl', () => {
  it('builds ws/wss URLs to /ws with the encoded token', () => {
    expect(liveWsUrl({ protocol: 'http:', host: '127.0.0.1:4317' }, 'a b')).toBe(
      'ws://127.0.0.1:4317/ws?token=a%20b',
    );
    expect(liveWsUrl({ protocol: 'https:', host: 'mac.tailnet.ts.net' }, 't')).toBe(
      'wss://mac.tailnet.ts.net/ws?token=t',
    );
  });
});

class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  close() {
    this.onclose?.();
  }
}
const Impl = FakeWS as unknown as typeof WebSocket;
const last = () => FakeWS.instances[FakeWS.instances.length - 1];

describe('useLiveEvents', () => {
  it('connects to /ws on the page host with the bootstrap token by default', () => {
    FakeWS.instances = [];
    window.__ORC_TOKEN__ = 'tok/1';
    const qc = makeQueryClient();
    const { unmount } = renderHook(() => useLiveEvents({ WebSocketImpl: Impl }), {
      wrapper: queryWrapper(qc),
    });
    expect(FakeWS.instances).toHaveLength(1);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(FakeWS.instances[0]?.url).toBe(`${proto}//${window.location.host}/ws?token=tok%2F1`);
    unmount();
  });

  it('applies each message to the cache and ignores malformed frames', () => {
    FakeWS.instances = [];
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, []);
    qc.setQueryData(inboxKey({ state: ['open'] }), []);
    const { result, unmount } = renderHook(
      () => useLiveEvents({ url: 'ws://x/ws?token=t', WebSocketImpl: Impl }),
      { wrapper: queryWrapper(qc) },
    );
    const ws = FakeWS.instances[0];
    expect(ws?.url).toBe('ws://x/ws?token=t');
    expect(result.current.connected).toBe(false);
    act(() => ws?.onopen?.());
    expect(result.current.connected).toBe(true);
    const send = (e: unknown) => act(() => ws?.onmessage?.({ data: JSON.stringify(e) }));
    send({ type: 'hello', serverTime: '2026-09-01T09:00:00.000Z' });
    send({ type: 'session.updated', session: liveSessionFixture({ id: 'z' }) });
    act(() => ws?.onmessage?.({ data: 'not json' }));
    send({ type: 'some.future.event' });
    send({ type: 'inbox.upserted', item: inboxItemFixture({ id: 'q' }) });
    expect(ids(qc)).toEqual(['z']);
    expect(qc.getQueryData<InboxItem[]>(inboxKey({ state: ['open'] }))?.map((i) => i.id)).toEqual(['q']);
    send({ type: 'session.removed', pk: 'claude:z' });
    expect(ids(qc)).toEqual([]);
    unmount();
  });

  it('reconnects with min(30s, 500ms * 2^attempt) backoff, reset on open, and stops on unmount', () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    const qc = makeQueryClient();
    const { result, unmount } = renderHook(
      () => useLiveEvents({ url: 'ws://x/ws?token=t', WebSocketImpl: Impl }),
      { wrapper: queryWrapper(qc) },
    );
    act(() => last()?.onopen?.());
    act(() => last()?.close());
    expect(result.current.connected).toBe(false);

    // attempts 0..6: 500, 1000, 2000, 4000, 8000, 16000, then capped at 30000
    const delays = [500, 1000, 2000, 4000, 8000, 16000, 30_000, 30_000];
    for (const [i, d] of delays.entries()) {
      act(() => vi.advanceTimersByTime(d - 1));
      expect(FakeWS.instances).toHaveLength(i + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeWS.instances).toHaveLength(i + 2);
      if (i < delays.length - 1) act(() => last()?.close());
    }

    // a successful open resets the backoff to 500ms
    act(() => last()?.onopen?.());
    expect(result.current.connected).toBe(true);
    const before = FakeWS.instances.length;
    act(() => last()?.close());
    act(() => vi.advanceTimersByTime(500));
    expect(FakeWS.instances).toHaveLength(before + 1);

    unmount();
    act(() => vi.advanceTimersByTime(120_000));
    expect(FakeWS.instances).toHaveLength(before + 1);
  });
});
