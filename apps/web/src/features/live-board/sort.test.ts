import { describe, expect, it } from 'vitest';
import { liveSessionFixture, sessionFixture } from '../../test/factories.ts';
import {
  attentionRank,
  filterByProject,
  formatDuration,
  groupLive,
  hasDrift,
  isAttention,
  permissionBadge,
  resumeCommand,
  STATUS_LABEL,
  shortPath,
  sortLive,
  testChipText,
} from './sort.ts';

describe('live board helpers', () => {
  it('sorts attention first, longest-waiting first', () => {
    const list = [
      liveSessionFixture({ id: 'busy' }, { status: 'busy', since: '2026-09-01T08:00:00.000Z' }),
      liveSessionFixture({ id: 'w-new' }, { status: 'waiting', since: '2026-09-01T09:30:00.000Z' }),
      liveSessionFixture({ id: 'review' }, { status: 'review' }),
      liveSessionFixture({ id: 'w-old' }, { status: 'waiting', since: '2026-09-01T09:00:00.000Z' }),
      liveSessionFixture({ id: 'ended' }, { status: 'ended' }),
      liveSessionFixture({ id: 'err' }, { status: 'error' }),
    ];
    expect(sortLive(list).map((s) => s.id)).toEqual(['w-old', 'w-new', 'review', 'err', 'busy', 'ended']);
    expect(attentionRank('blocked')).toBeLessThan(attentionRank('error'));
    expect(isAttention('waiting')).toBe(true);
    expect(isAttention('busy')).toBe(false);
    expect(STATUS_LABEL.review).toBe('Ready for review');
  });

  it('filters and groups', () => {
    const list = [
      sessionFixture({ id: 'a', projectId: 'wakecap', tickets: ['SAF-1'] }),
      sessionFixture({ id: 'b', projectId: 'forza', source: 'codex' }),
    ];
    expect(filterByProject(list, 'forza').map((s) => s.id)).toEqual(['b']);
    expect(filterByProject(list, undefined)).toHaveLength(2);
    expect(groupLive(list, 'none')).toEqual([{ key: 'all', label: 'All sessions', sessions: list }]);
    expect(groupLive(list, 'project').map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['wakecap', ['a']],
      ['forza', ['b']],
    ]);
    expect(groupLive(list, 'ticket').map((g) => g.label)).toEqual(['SAF-1', 'No ticket']);
    expect(groupLive(list, 'source').map((g) => g.label)).toEqual(['Claude', 'Codex']);
  });

  it('formats durations, badges, paths and commands', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(formatDuration(2 * 86400_000 + 4 * 3600_000)).toBe('2d 4h');
    expect(formatDuration(-5)).toBe('0s');
    expect(permissionBadge('bypassPermissions')).toBe('bypass');
    expect(permissionBadge('plan')).toBe('plan');
    expect(permissionBadge('acceptEdits')).toBe('auto');
    expect(permissionBadge('default')).toBe('default');
    expect(permissionBadge('weird')).toBe('custom');
    expect(permissionBadge(null)).toBeNull();
    expect(hasDrift(sessionFixture({ cwds: ['/a', '/a/b'] }))).toBe(true);
    expect(hasDrift(sessionFixture())).toBe(false);
    expect(shortPath('/Users/test/Wakecap/Backend/svc')).toBe('~/Wakecap/Backend/svc');
    expect(shortPath('/Users/test/a/b/c/d/e/f')).toBe('~/…/d/e/f');
    expect(resumeCommand(sessionFixture({ id: 's-1', startCwd: "/Users/test/it's" }))).toBe(
      "cd '/Users/test/it'\\''s' && claude --resume s-1",
    );
    expect(resumeCommand(sessionFixture({ id: 'c-1', source: 'codex' }))).toBe(
      "cd '/Users/test/Wakecap' && codex resume c-1",
    );
    expect(testChipText({ ts: '', command: '', passed: 18, failed: 0, skipped: 0, durationMs: null })).toBe(
      '✓ 18 · ✗ 0',
    );
  });
});
