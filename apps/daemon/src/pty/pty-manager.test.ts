import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../live/event-bus.ts';
import { createPtyManager, warnIfChildSessionEnv } from './pty-manager.ts';

describe('pty manager', () => {
  it('spawns, streams, replays scrollback and reports exit', async () => {
    const bus = createEventBus();
    const exits: Array<number | null> = [];
    bus.on('pty.exited', (e) => exits.push(e.code));
    const pty = createPtyManager({ bus });
    const info = pty.spawn({
      command: '/bin/sh',
      args: ['-c', 'printf ready; exec cat'],
      cwd: tmpdir(),
      sessionPk: 'claude:s',
    });
    expect(info).toMatchObject({ sessionPk: 'claude:s', cols: 120, rows: 36, exitedAt: null });
    expect(info.pid).toBeGreaterThan(0);

    let out = '';
    const a = pty.attach(info.id, (d) => {
      out += d;
    });
    await vi.waitFor(() => expect(out).toContain('ready'));
    pty.write(info.id, 'hello\r');
    await vi.waitFor(() => expect(out).toContain('hello'));
    a.detach();
    expect(pty.attach(info.id, () => undefined).scrollback).toContain('ready');

    pty.resize(info.id, 100, 30);
    expect(pty.get(info.id)).toMatchObject({ cols: 100, rows: 30 });
    expect(pty.list().map((p) => p.id)).toEqual([info.id]);

    pty.kill(info.id);
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(pty.get(info.id)?.exitedAt).not.toBeNull();
    expect(() => pty.write(info.id, 'x')).toThrow(/exited/);
    pty.remove(info.id);
    expect(pty.get(info.id)).toBeUndefined();
    expect(() => pty.write(info.id, 'x')).toThrow(/not found/);
  });

  it('caps the scrollback', async () => {
    const pty = createPtyManager({ bus: createEventBus(), scrollbackBytes: 1000 });
    const info = pty.spawn({
      command: '/bin/sh',
      args: ['-c', 'head -c 5000 /dev/zero | tr "\\0" x; exec cat'],
      cwd: tmpdir(),
    });
    await vi.waitFor(() =>
      expect(pty.attach(info.id, () => undefined).scrollback.length).toBeGreaterThanOrEqual(900),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.attach(info.id, () => undefined).scrollback.length).toBeLessThanOrEqual(1000);
    pty.disposeAll();
    expect(pty.list()).toEqual([]);
  });

  it('sends bracketed paste through sendText', async () => {
    const pty = createPtyManager({ bus: createEventBus() });
    const info = pty.spawn({ command: '/bin/cat', args: [], cwd: tmpdir() });
    let out = '';
    pty.attach(info.id, (d) => {
      out += d;
    });
    await pty.sendText(info.id, 'multi\nline');
    await vi.waitFor(() => expect(out).toContain('line'));
    pty.disposeAll();
  });

  // Controller ruling 2 (CRITICAL): a `claude` spawned from inside another Claude session
  // inherits CLAUDE_CODE_CHILD_SESSION and silently writes no transcript (see
  // plan/spikes/S2-S8.md, "child-session env inheritance"). spawn() must strip that marker
  // and force persistence so every session this app launches stays indexable.
  it('strips CLAUDE_CODE_CHILD_SESSION and forces session persistence for spawned children', async () => {
    const pty = createPtyManager({ bus: createEventBus() });
    const prevMarker = process.env.CLAUDE_CODE_CHILD_SESSION;
    process.env.CLAUDE_CODE_CHILD_SESSION = 'parent-session-id';
    try {
      const info = pty.spawn({ command: '/bin/sh', args: ['-c', 'env'], cwd: tmpdir() });
      await vi.waitFor(() => expect(pty.get(info.id)?.exitedAt).not.toBeNull());
      const out = pty.attach(info.id, () => undefined).scrollback;
      expect(out).not.toContain('CLAUDE_CODE_CHILD_SESSION=');
      expect(out).toContain('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1');
    } finally {
      if (prevMarker === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
      else process.env.CLAUDE_CODE_CHILD_SESSION = prevMarker;
      pty.disposeAll();
    }
  });

  it('never sends input to a pty id it did not spawn', () => {
    const pty = createPtyManager({ bus: createEventBus() });
    expect(() => pty.write('not-a-real-id', 'x')).toThrow(/not found/);
    expect(() => pty.resize('not-a-real-id', 10, 10)).toThrow(/not found/);
  });
});

describe('warnIfChildSessionEnv', () => {
  it('warns when the daemon process itself carries the child-session marker', () => {
    const warn = vi.fn();
    warnIfChildSessionEnv({ CLAUDE_CODE_CHILD_SESSION: '1' }, warn);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stays silent when the marker is absent', () => {
    const warn = vi.fn();
    warnIfChildSessionEnv({}, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
