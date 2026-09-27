import type { InboxItem } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { createStdoutNotifyChannel, NOTIFY_PREFIX, notifyLine } from '../../src/notify/stdout-bridge.ts';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'waiting',
  sessionId: 's1',
  projectId: 'wakecap',
  ticket: 'SAF-1787',
  reason: 'waiting for input (token=abc123)',
  dedupeKey: 'waiting:claude:s1',
  createdAt: '2026-09-18T09:00:00.000Z',
  updatedAt: '2026-09-18T09:00:00.000Z',
  state: 'open',
  snoozeUntil: null,
  payload: { source: 'claude', id: 's1' },
  ...over,
});

describe('stdout notify bridge', () => {
  it('builds a redacted, human-readable line', () => {
    expect(notifyLine(item(), 'http://127.0.0.1:4317/sessions/claude/s1')).toEqual({
      title: 'Waiting · SAF-1787',
      body: 'waiting for input (token=«redacted:secret»)',
      url: 'http://127.0.0.1:4317/sessions/claude/s1',
      kind: 'waiting',
    });
    expect(
      notifyLine(item({ kind: 'automation_result', ticket: null, reason: 'Fix CI: success' }), 'u').title,
    ).toBe('Automation result');
  });

  it('writes one prefixed JSON line per notification', async () => {
    const lines: string[] = [];
    const channel = createStdoutNotifyChannel((l) => lines.push(l));
    expect(channel.id).toBe('macos');
    await channel.send(item(), 'http://127.0.0.1:4317/sessions/claude/s1');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(NOTIFY_PREFIX)).toBe(true);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse((lines[0] ?? '').slice(NOTIFY_PREFIX.length))).toMatchObject({ kind: 'waiting' });
  });
});
