import type { WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { cleanTitle, groupByStage, STAGE_ORDER, sessionHref, stageIndex } from './stages.ts';

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

  it('cleans XML-ish prompt wrappers out of a raw title', () => {
    // a wrapper block (tag plus its own content) is boilerplate the slash command inserted, not the title
    expect(
      cleanTitle(
        '<command-message>marauder is running…</command-message>\n<command-args>SAF-2000</command-args>\n\nTake ticket SAF-2000 end to end',
      ),
    ).toBe('Take ticket SAF-2000 end to end');
    expect(cleanTitle('<recommended_plugins> Here is a list of plugins </recommended_plugins>')).toBe('');
    expect(cleanTitle('Exclude weekends from the SLA deadline')).toBe(
      'Exclude weekends from the SLA deadline',
    );
    // a lone, unmatched tag (no closing pair) is stripped but its surrounding text stays
    expect(cleanTitle('<system-reminder>one two')).toBe('one two');
    expect(cleanTitle(null)).toBe('');
    expect(cleanTitle(undefined)).toBe('');
    expect(cleanTitle('')).toBe('');
  });
});
