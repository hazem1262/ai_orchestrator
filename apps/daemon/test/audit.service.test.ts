import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { createEventBus } from '../src/live/event-bus.ts';
import { audited, createAuditService, DeniedError, sessionPkOf } from '../src/services/audit/audit.ts';

let handle: ReturnType<typeof openDb>;
let clock: number;
const now = () => new Date(Date.UTC(2026, 8, 17, 10, 0, 0) + clock++ * 1000);

beforeEach(() => {
  clock = 0;
  handle = openDb(join(mkdtempSync(join(tmpdir(), 'orc-audit-')), 'index.db'));
});
afterEach(() => handle.close());

const base = { actor: 'user' as const, actorDetail: null, params: {} };

describe('AuditService', () => {
  it('records, redacts params, derives sessionPk and emits a bus event', () => {
    const bus = createEventBus();
    const seen: AuditEntry[] = [];
    bus.on('audit.recorded', (e) => seen.push(e.entry));
    const audit = createAuditService({ db: handle.db, bus, now });
    const e = audit.record({
      ...base,
      action: 'pty.input',
      target: 'claude:s-basic',
      params: { text: 'PGPASSWORD=hunter2 psql', env: { API_KEY: 'abc' }, long: 'x'.repeat(3000) },
      result: 'ok',
      error: null,
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.ts).toBe('2026-09-17T10:00:00.000Z');
    expect(e.params).toEqual({
      text: 'PGPASSWORD=«redacted:secret» psql',
      env: { API_KEY: '«redacted:secret»' },
      long: `${'x'.repeat(2000)}…`,
    });
    expect(seen).toEqual([e]);
    expect(audit.list({ sessionPk: 'claude:s-basic' })).toEqual([e]);
  });

  it('filters by action (exact and area.*), actor, time and text, newest first', () => {
    const audit = createAuditService({ db: handle.db, now });
    audit.record({ ...base, action: 'session.resume', target: 'claude:a', result: 'ok', error: null });
    audit.record({
      ...base,
      action: 'session.kill',
      target: 'claude:b',
      result: 'error',
      error: 'not_found: gone',
    });
    audit.record({
      ...base,
      actor: 'automation',
      action: 'pty.input',
      target: 'pty:1',
      params: { sessionPk: 'codex:c' },
      result: 'ok',
      error: null,
    });
    expect(audit.list({}).map((e) => e.action)).toEqual(['pty.input', 'session.kill', 'session.resume']);
    expect(audit.list({ action: 'session.*' }).map((e) => e.action)).toEqual([
      'session.kill',
      'session.resume',
    ]);
    expect(audit.list({ action: 'session.kill' })).toHaveLength(1);
    expect(audit.list({ actor: 'automation' })).toHaveLength(1);
    expect(audit.list({ sessionPk: 'codex:c' })).toHaveLength(1);
    expect(
      audit.list({ from: '2026-09-17T10:00:01.000Z', to: '2026-09-17T10:00:01.999Z' }).map((e) => e.action),
    ).toEqual(['session.kill']);
    expect(audit.list({ q: 'gone' })).toHaveLength(1);
    expect(audit.list({ limit: 1 })).toHaveLength(1);
  });

  it('is append-only at the database level', () => {
    const audit = createAuditService({ db: handle.db, now });
    audit.record({ ...base, action: 'session.launch', target: null, result: 'ok', error: null });
    expect(() => handle.raw.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => handle.raw.prepare("UPDATE audit_log SET result = 'error'").run()).toThrow(/append-only/);
  });
});

describe('audited()', () => {
  it('records ok, error and denied results', async () => {
    const audit = createAuditService({ db: handle.db, now });
    const meta = { ...base, action: 'session.resume', target: 'claude:s-basic' };
    await expect(audited(audit, meta, async () => 42)).resolves.toBe(42);
    await expect(
      audited(audit, meta, async () => {
        throw new Error('spawn failed token=abc');
      }),
    ).rejects.toThrow('spawn failed');
    await expect(
      audited(audit, meta, async () => {
        throw new DeniedError({ denied: true, reason: 'matches deny pattern x' });
      }),
    ).rejects.toBeInstanceOf(DeniedError);
    const results = audit.list({}).map((e) => [e.result, e.error]);
    expect(results).toEqual([
      ['denied', 'matches deny pattern x'],
      ['error', 'spawn failed token=«redacted:secret»'],
      ['ok', null],
    ]);
  });
});

describe('sessionPkOf', () => {
  it.each([
    ['claude:s-basic', {}, 'claude:s-basic'],
    ['pty:abc', { sessionPk: 'codex:x' }, 'codex:x'],
    ['/Users/test/Wakecap', {}, null],
    [null, { sessionPk: 'nope' }, null],
  ] as const)('%s', (target, params, expected) => {
    expect(sessionPkOf(target, params)).toBe(expected);
  });
});
