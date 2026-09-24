import { describe, expect, it } from 'vitest';
import { ev } from '../test-utils/events.ts';
import { permissionBadge } from './permission.ts';
import { commandOf, detectProdTouches } from './prod-detect.ts';
import { scanTextForSecrets } from './secret-scan.ts';

const driftEvents = [
  ev({ seq: 1, ts: '2026-09-03T08:00:00.000Z', kind: 'prompt', text: 'look at the svc repo' }),
  ev({
    seq: 2,
    ts: '2026-09-03T08:00:05.000Z',
    kind: 'tool_call',
    tool: 'Bash',
    toolUseId: 'dtu1',
    input: { command: "PGPASSWORD=hunter2 psql -h prod-db.internal -c 'select 1'" },
  }),
  ev({
    seq: 3,
    ts: '2026-09-03T08:00:09.000Z',
    kind: 'tool_call',
    tool: 'Skill',
    toolUseId: 'dtu2',
    input: { skill: 'production_server_db' },
    agentId: 'ag9',
  }),
  ev({
    seq: 4,
    ts: '2026-09-03T08:00:10.000Z',
    kind: 'tool_call',
    tool: 'Bash',
    toolUseId: 'dtu3',
    input: { command: 'pnpm test' },
  }),
];

describe('detectProdTouches', () => {
  it('finds prod skills and prod commands, with redacted detail', () => {
    const touches = detectProdTouches(driftEvents);
    expect(touches.map((t) => [t.seq, t.kind, t.tool, t.agentId])).toEqual([
      [2, 'command', 'Bash', null],
      [3, 'skill', 'Skill', 'ag9'],
    ]);
    expect(touches[0]?.detail).toContain('«redacted:secret»');
    expect(JSON.stringify(touches)).not.toContain('hunter2');
    expect(touches[1]?.detail).toBe('production_server_db');
  });

  it('uses project patterns and custom skill lists', () => {
    const touches = detectProdTouches(driftEvents, { prodSkills: [], prodPatterns: ['pnpm\\s+test'] });
    expect(touches.map((t) => t.seq)).toEqual([2, 4]);
  });

  it('reads codex shell commands given as arrays', () => {
    const e = ev({
      seq: 1,
      ts: '2026-09-01T00:00:00.000Z',
      kind: 'tool_call',
      tool: 'shell',
      input: { command: ['terraform', 'apply'] },
    });
    expect(commandOf(e)).toBe('terraform apply');
    expect(detectProdTouches([e])).toHaveLength(1);
  });
});

describe('permissionBadge', () => {
  it.each([
    [[], 'unknown'],
    [[null, undefined, ''], 'unknown'],
    [['bypassPermissions'], 'bypass'],
    [['plan'], 'plan'],
    [['acceptEdits'], 'auto'],
    [['default'], 'default'],
    [['plan', 'bypassPermissions'], 'bypass'],
    [['default', 'acceptEdits'], 'auto'],
    [['plan', 'default'], 'default'],
    [['acceptEdits', 'bypassPermissions'], 'custom'],
    [['weird-mode'], 'custom'],
    [['never'], 'bypass'],
    [['on-request'], 'default'],
  ] as const)('%j → %s', (modes, expected) => {
    expect(permissionBadge(modes)).toBe(expected);
  });
});

describe('scanTextForSecrets', () => {
  it('reports line and kind only', () => {
    const pat = `gh${'p_'}${'b'.repeat(36)}`;
    const text = [
      '{',
      `  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${pat}" },`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env reference in a JSON file
      '  "other": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },',
      '  "db": "postgres://admin:hunter2@db.internal:5432/app",',
      '  "API_KEY": "abcdefghijkl"',
      '}',
      'PGPASSWORD=hunter2 psql',
    ].join('\n');
    const findings = scanTextForSecrets(text);
    expect(findings).toEqual([
      { line: 2, kind: 'github' },
      { line: 2, kind: 'json-secret-field' },
      { line: 4, kind: 'credentials' },
      { line: 5, kind: 'json-secret-field' },
      { line: 7, kind: 'secret' },
    ]);
    const s = JSON.stringify(findings);
    expect(s).not.toContain(pat);
    expect(s).not.toContain('hunter2');
  });

  it('returns nothing for clean text', () => {
    expect(scanTextForSecrets('# /review\nRun the review skill.')).toEqual([]);
  });
});
