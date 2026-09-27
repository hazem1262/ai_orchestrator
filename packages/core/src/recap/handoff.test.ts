import { describe, expect, it } from 'vitest';
import type { Handoff, TimelineEvent } from '../types/index.ts';
import { buildResumePrompt, collectHandoffEvidence, handoffToMarkdown, parseHandoffJson } from './handoff.ts';

const call = (seq: number, command: string): TimelineEvent => ({
  sessionId: 's',
  agentId: null,
  uuid: `u${seq}`,
  parentUuid: null,
  seq,
  ts: 't',
  kind: 'tool_call',
  turn: 1,
  text: null,
  tool: 'Bash',
  toolUseId: `t${seq}`,
  mcpServer: null,
  input: { command },
  messageId: null,
  model: null,
  usage: null,
  durationMs: null,
});

describe('handoff helpers', () => {
  it('collects structured, redacted evidence', () => {
    const h = collectHandoffEvidence(
      {
        lastTest: {
          ts: '2026-09-17T10:00:00.000Z',
          command: 'pnpm vitest run',
          passed: 18,
          failed: 1,
          skipped: 0,
          durationMs: 1400,
        },
        prs: [{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1' }],
        tickets: ['SAF-1'],
        filesTouched: ['/a.ts', '/a.ts', '/b.ts'],
      },
      [
        call(1, 'ls -la'),
        call(2, 'PGPASSWORD=hunter2 pnpm test'),
        call(3, 'git push origin feat/x'),
        call(4, 'pnpm test'),
        call(5, 'PGPASSWORD=hunter2 pnpm test'),
      ],
      ['/w/plans/SAF-1-x.md'],
    );
    expect(h.evidence).toEqual([
      'Tests: 18 passed, 1 failed, 0 skipped — `pnpm vitest run` (2026-09-17T10:00:00.000Z)',
      'PR: https://github.com/o/r/pull/1',
      'Ran: `PGPASSWORD=«redacted:secret» pnpm test`',
      'Ran: `git push origin feat/x`',
      'Ran: `pnpm test`',
    ]);
    expect(h.files).toEqual(['/a.ts', '/b.ts']);
    expect(h.links).toEqual(['https://github.com/o/r/pull/1', 'ticket:SAF-1', '/w/plans/SAF-1-x.md']);
  });

  it('parses JSON from model output, tolerating fences', () => {
    expect(
      parseHandoffJson('```json\n{"status":"blocked","summary":"S","nextSteps":["a"],"blockers":["b"]}\n```'),
    ).toEqual({
      status: 'blocked',
      summary: 'S',
      nextSteps: ['a'],
      blockers: ['b'],
    });
    expect(parseHandoffJson('{"status":"weird","summary":"S"}')).toEqual({
      status: 'in_progress',
      summary: 'S',
      nextSteps: [],
      blockers: [],
    });
    expect(parseHandoffJson('no json here')).toBeNull();
    expect(parseHandoffJson('{"summary": 3}')).toBeNull();
  });

  it('renders markdown and a resume prompt', () => {
    const h: Handoff = {
      id: 'h1',
      sessionId: 'claude:s1',
      status: 'in_progress',
      summary: 'Did X.',
      evidence: ['PR: u'],
      files: ['/a.ts'],
      nextSteps: ['Fix test', 'Open PR'],
      blockers: [],
      links: ['u'],
      createdAt: '2026-09-17T10:00:00.000Z',
    };
    const md = handoffToMarkdown(h);
    expect(md).toContain('# Handoff — in_progress');
    expect(md).toContain('## Next steps\n1. Fix test\n2. Open PR');
    expect(md).toContain('## Blockers\n- none');
    expect(md).toContain('- `/a.ts`');
    const p = buildResumePrompt(h);
    expect(p.startsWith('You are continuing')).toBe(true);
    expect(p).toContain(md);
  });
});
