import type { WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { groupByStage, STAGE_ORDER, sessionHref, stageIndex } from './stages.ts';

const s = (ticket: string, stage: WorkStream['stage']): WorkStream => ({
  ticket,
  projectId: 'wakecap',
  title: null,
  stage,
  sessionIds: [],
  prs: [],
  plans: [],
  worktrees: [],
  costUsd: 1,
  lastActivityAt: 't',
});

describe('stages', () => {
  it('orders stages from planned to released', () => {
    expect(STAGE_ORDER).toEqual([
      'planned',
      'implementing',
      'in_review',
      'pr_open',
      'merged',
      'backmerged',
      'released',
    ]);
    expect(stageIndex('merged')).toBe(4);
  });

  it('groups streams into every column, even empty ones', () => {
    const cols = groupByStage([s('SAF-1', 'merged'), s('SAF-2', 'planned'), s('SAF-3', 'merged')]);
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.streams.length)).toEqual([1, 0, 0, 0, 2, 0, 0]);
    expect(cols[4]?.label).toBe('Merged');
  });

  it('builds session links from a pk', () => {
    expect(sessionHref('claude:s-basic')).toBe('/sessions/claude/s-basic');
    expect(sessionHref('codex:c0dex:1')).toBe('/sessions/codex/c0dex%3A1');
  });
});
