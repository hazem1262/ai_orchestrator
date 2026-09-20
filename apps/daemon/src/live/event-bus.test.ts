import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './event-bus.ts';

describe('event bus', () => {
  it('delivers typed events and unsubscribes', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on('pty.exited', (e) => seen.push(`${e.ptyId}:${e.code}`));
    bus.on('session.indexed', (e) => seen.push(e.pk));
    bus.emit({ type: 'pty.exited', ptyId: 'p1', code: 0 });
    bus.emit({ type: 'session.indexed', pk: 'claude:s' });
    off();
    bus.emit({ type: 'pty.exited', ptyId: 'p2', code: 1 });
    expect(seen).toEqual(['p1:0', 'claude:s']);
  });

  it('isolates failing handlers', () => {
    const onError = vi.fn();
    const bus = createEventBus({ onError });
    const ok = vi.fn();
    bus.on('index.progress', () => {
      throw new Error('boom');
    });
    bus.on('index.progress', ok);
    bus.emit({ type: 'index.progress', done: 1, total: 2 });
    expect(ok).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { type: 'index.progress', done: 1, total: 2 });
  });
});
