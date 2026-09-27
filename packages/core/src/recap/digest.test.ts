import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../types/index.ts';
import {
  approxTokens,
  buildRecapDigest,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_RECAP_PROMPT,
  firstLine,
  type RecapSessionInput,
  renderPromptTemplate,
} from './digest.ts';

const ghp = `gh${'p_'}${'abcdefghijklmnopqrstuvwxyz0123456789'}`;

const session: RecapSessionInput = {
  id: 's-basic',
  source: 'claude',
  projectId: 'wakecap',
  name: 'Notification service test check',
  startCwd: '/Users/test/Wakecap',
  startedAt: '2026-09-01T09:00:00.000Z',
  lastActivityAt: '2026-09-01T09:07:00.000Z',
  models: ['claude-opus-5'],
  usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 },
  tickets: ['SAF-1787'],
  prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
  skills: ['conductor'],
  filesTouched: ['/Users/test/Wakecap/Backend/svc/a.ts'],
  linesAdded: 1,
  linesRemoved: 1,
  awaySummary: 'Ran tests (18 passed) and edited a.ts.',
  promptCount: 3,
};
const e = (p: Partial<TimelineEvent> & { seq: number; kind: TimelineEvent['kind'] }): TimelineEvent => ({
  sessionId: 's-basic',
  agentId: null,
  uuid: `u${p.seq}`,
  parentUuid: null,
  ts: '2026-09-01T09:00:00.000Z',
  turn: 1,
  text: null,
  tool: null,
  toolUseId: null,
  mcpServer: null,
  input: null,
  messageId: null,
  model: null,
  usage: null,
  durationMs: null,
  ...p,
});
const events: TimelineEvent[] = [
  e({ seq: 1, kind: 'prompt', text: `check the notification service tests, token ${ghp}` }),
  e({ seq: 2, kind: 'assistant_text', text: 'Running the tests.' }),
  e({
    seq: 3,
    kind: 'tool_call',
    tool: 'Bash',
    input: { command: 'PGPASSWORD=hunter2 psql -c "select SECRET_INPUT"' },
  }),
  e({ seq: 4, kind: 'tool_result', text: 'SECRET_TOOL_OUTPUT rows=3' }),
  e({ seq: 5, kind: 'thinking', text: 'SECRET_THINKING' }),
  e({ seq: 6, kind: 'tool_call', tool: 'Edit', input: { file_path: '/x' } }),
  e({ seq: 7, kind: 'tool_call', tool: 'Bash', input: { command: 'ls' } }),
  e({ seq: 8, kind: 'system', text: 'SECRET_SYSTEM' }),
  e({ seq: 9, kind: 'error', turn: 2, text: 'API Error: 529 overloaded' }),
  e({ seq: 10, kind: 'prompt', turn: 3, text: '/review the change' }),
];
const tests = [
  {
    ts: '2026-09-01T09:00:30.000Z',
    command: 'PGPASSWORD=hunter2 pnpm vitest run',
    passed: 18,
    failed: 0,
    skipped: 0,
    durationMs: 1400,
  },
];

describe('buildRecapDigest', () => {
  it('builds a compact, redacted digest without tool outputs or inputs', () => {
    const d = buildRecapDigest({
      session,
      events,
      tests,
      plans: ['/Users/test/Wakecap/plans/SAF-1787-x.md'],
      maxInputTokens: 30000,
    });
    expect(d.truncated).toBe(false);
    expect(d.text).toContain('name: Notification service test check');
    expect(d.text).toContain('models: claude-opus-5 · cost: $0.42 · lines: +1 −1 · prompts: 3');
    expect(d.text).toContain('tickets: SAF-1787');
    expect(d.text).toContain('PRs: https://github.com/example-org/svc/pull/231');
    expect(d.text).toContain('plans: /Users/test/Wakecap/plans/SAF-1787-x.md');
    expect(d.text).toContain('Bash ×2, Edit ×1');
    expect(d.text).toContain('- /Users/test/Wakecap/Backend/svc/a.ts');
    expect(d.text).toContain(
      '`PGPASSWORD=«redacted:secret» pnpm vitest run`: 18 passed, 0 failed, 0 skipped',
    );
    expect(d.text).toContain('[turn 1] USER: check the notification service tests, token «redacted:github»');
    expect(d.text).toContain('[turn 1] ASSISTANT: Running the tests.');
    expect(d.text).toContain('[turn 2] ERROR: API Error: 529 overloaded');
    expect(d.text).toContain('[turn 3] USER: /review the change');
    for (const secret of [
      'SECRET_INPUT',
      'SECRET_TOOL_OUTPUT',
      'SECRET_THINKING',
      'SECRET_SYSTEM',
      'hunter2',
      'ghp_',
    ]) {
      expect(d.text).not.toContain(secret);
    }
    expect(d.approxTokens).toBe(approxTokens(d.text));
  });

  it('caps the size and keeps the first and latest conversation items', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      e({
        seq: i + 1,
        turn: i + 1,
        kind: i % 2 === 0 ? 'prompt' : 'assistant_text',
        text: `item-${i} ${'x'.repeat(300)}`,
      }),
    );
    const d = buildRecapDigest({
      session,
      events: many,
      tests: [],
      plans: [],
      maxInputTokens: 3000,
      reserveTokens: 500,
    });
    expect(d.truncated).toBe(true);
    expect(d.omittedItems).toBeGreaterThan(0);
    expect(d.text.length).toBeLessThanOrEqual((3000 - 500) * 4);
    expect(d.text).toContain('item-0 ');
    expect(d.text).toContain('item-399 ');
    expect(d.text).toContain(`[… ${d.omittedItems} conversation items omitted …]`);
  });

  it('truncates long single items', () => {
    const d = buildRecapDigest({
      session,
      events: [e({ seq: 1, kind: 'prompt', text: 'y'.repeat(5000) })],
      tests: [],
      plans: [],
      maxInputTokens: 30000,
    });
    expect(d.text).toMatch(/USER: y{600}…/);
  });
});

describe('templates', () => {
  it('renders variables and leaves no placeholders', () => {
    const out = renderPromptTemplate(DEFAULT_RECAP_PROMPT, { language: 'Arabic', digest: 'DIGEST' });
    expect(out).toContain('Write in Arabic.');
    expect(out).toContain('**What to check:**');
    expect(out.endsWith('DIGEST\n')).toBe(true);
    expect(renderPromptTemplate('a {{missing}} b', {})).toBe('a  b');
    expect(DEFAULT_DAILY_PROMPT).toContain('{{date}}');
    expect(DEFAULT_HANDOFF_PROMPT).toContain('"nextSteps"');
  });

  it('extracts the first non-empty line', () => {
    expect(firstLine('\n  \nFixed it.\nmore')).toBe('Fixed it.');
    expect(firstLine(null)).toBeNull();
  });
});
