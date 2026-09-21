import { describe, expect, it } from 'vitest';
import { categorizeTool, inferStage } from './stage.ts';

describe('categorizeTool', () => {
  it.each([
    ['Read', {}, 'read'],
    ['Grep', {}, 'read'],
    ['Edit', {}, 'edit'],
    ['MultiEdit', {}, 'edit'],
    ['Write', {}, 'edit'],
    ['Bash', { command: 'pnpm vitest run' }, 'test'],
    ['Bash', { command: 'rg weekend src' }, 'read'],
    ['Bash', { command: 'git diff --stat' }, 'read'],
    ['Bash', { command: 'pnpm install' }, 'other'],
    ['mcp__claude_ai_Linear__save_issue', {}, 'other'],
  ] as const)('%s %j → %s', (tool, input, expected) => {
    expect(categorizeTool(tool, input)).toBe(expected);
  });
});

describe('inferStage', () => {
  it('is null with no activity', () => {
    expect(inferStage({ categories: [], turnEnded: false, changedFiles: 0 })).toBeNull();
  });
  it('reports the furthest stage reached in the turn', () => {
    expect(inferStage({ categories: ['other'], turnEnded: false, changedFiles: 0 })).toBe('understand');
    expect(inferStage({ categories: ['read', 'read'], turnEnded: false, changedFiles: 0 })).toBe(
      'understand',
    );
    expect(inferStage({ categories: ['read', 'edit', 'read'], turnEnded: false, changedFiles: 1 })).toBe(
      'modify',
    );
    expect(inferStage({ categories: ['edit', 'test', 'edit'], turnEnded: false, changedFiles: 1 })).toBe(
      'test',
    );
  });
  it('is review when the turn ended with changes', () => {
    expect(inferStage({ categories: ['edit'], turnEnded: true, changedFiles: 1 })).toBe('review');
    expect(inferStage({ categories: ['read'], turnEnded: true, changedFiles: 0 })).toBe('understand');
  });
});
