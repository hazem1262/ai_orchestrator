import type { AuditEntry } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../services/audit/audit.ts';
import { stripControl, withPtyInputAudit } from './audited-pty.ts';
import type { PtyInfo, PtyManager } from './pty-manager.ts';

function fakes() {
  const recorded: Array<Omit<AuditEntry, 'id' | 'ts'>> = [];
  const audit: AuditService = {
    record: (e) => {
      recorded.push(e);
      return { ...e, id: 'x', ts: 't' };
    },
    list: () => [],
  };
  const info = { id: 'p1', sessionPk: 'claude:s-basic' } as PtyInfo;
  const writes: string[] = [];
  const pty: PtyManager = {
    spawn: vi.fn(() => info),
    write: vi.fn((id: string, d: string) => {
      if (id === 'bad') throw new Error('not_owned');
      writes.push(d);
    }),
    sendText: vi.fn(async () => undefined),
    resize: vi.fn(),
    kill: vi.fn(),
    attach: vi.fn(() => ({ scrollback: '', detach: () => undefined })),
    list: vi.fn(() => [info]),
    get: vi.fn((id: string) => (id === 'p1' ? info : undefined)),
    remove: vi.fn(),
    disposeAll: vi.fn(),
  };
  return { recorded, audit, pty, writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withPtyInputAudit', () => {
  it('coalesces keystrokes into one entry per line and passes data through', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    for (const ch of 'yes') p.write('p1', ch);
    expect(f.recorded).toHaveLength(0);
    p.write('p1', '\r');
    expect(f.writes.join('')).toBe('yes\r');
    expect(f.recorded).toEqual([
      {
        actor: 'user',
        actorDetail: null,
        action: 'pty.input',
        target: 'claude:s-basic',
        params: { via: 'keys', ptyId: 'p1', bytes: 4, text: 'yes' },
        result: 'ok',
        error: null,
      },
    ]);
  });

  it('flushes after idle time and on kill, and redacts', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit, { idleMs: 1000 });
    p.write('p1', 'token=abc');
    vi.advanceTimersByTime(999);
    expect(f.recorded).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(f.recorded[0]?.params.text).toBe('token=«redacted:secret»');
    p.write('p1', 'ab');
    p.kill('p1');
    expect(f.recorded).toHaveLength(2);
    expect(f.pty.kill).toHaveBeenCalledWith('p1', undefined);
  });

  it('records failed writes as errors and rethrows', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    expect(() => p.write('bad', 'x')).toThrow('not_owned');
    expect(f.recorded[0]).toMatchObject({ target: 'pty:bad', result: 'error', error: 'not_owned' });
  });

  it('audits sendText via audited()', async () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    await p.sendText('p1', 'approve the plan');
    expect(f.pty.sendText).toHaveBeenCalledWith('p1', 'approve the plan');
    expect(f.recorded[0]).toMatchObject({
      action: 'pty.input',
      params: { via: 'paste', text: 'approve the plan' },
      result: 'ok',
    });
  });
});

describe('stripControl', () => {
  it('removes escape sequences and applies backspace', () => {
    const ESC = String.fromCharCode(27);
    expect(stripControl(`${ESC}[200~hi${ESC}[201~`)).toBe('hi');
    expect(stripControl(`ab${String.fromCharCode(127)}c${ESC}[A`)).toBe('ac');
    expect(stripControl('a\rb')).toBe('a\nb');
  });
});
