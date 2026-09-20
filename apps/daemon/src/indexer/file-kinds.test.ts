import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { classifyPath, listIndexableFiles } from './file-kinds.ts';

describe('file kinds', () => {
  const homes = useTempHomes();

  it('classifies known paths', () => {
    const c = (rel: string) => classifyPath(join(homes.claudeHome, rel), homes.paths);
    expect(c('projects/-Users-test-Wakecap/s-basic.jsonl')).toEqual({
      kind: 'claude-main',
      sessionId: 's-basic',
      agentId: null,
    });
    expect(c('projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.jsonl')).toEqual({
      kind: 'claude-subagent',
      sessionId: 's-subagents',
      agentId: 'ag2',
    });
    expect(c('projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.meta.json')?.kind).toBe(
      'claude-subagent-meta',
    );
    expect(c('history.jsonl')?.kind).toBe('claude-history');
    expect(c('sessions/41001.json')).toBeNull();
    expect(c('sessions/41001.abc.key')).toBeNull();
    expect(c('projects/-Users-test-Wakecap/s-basic/tool-results/x.txt')).toBeNull();
    expect(
      classifyPath(
        join(homes.codexHome, 'sessions/2026/09/01/rollout-2026-09-01T09-00-00-x.jsonl'),
        homes.paths,
      )?.kind,
    ).toBe('codex-rollout');
    expect(classifyPath(join(homes.codexHome, 'history.jsonl'), homes.paths)).toBeNull();
  });

  it('lists files in indexing order', () => {
    const files = listIndexableFiles(homes.paths).map((f) => f.replace(`${homes.root}/`, ''));
    expect(files).toEqual([
      'claude/projects/-Users-test-Wakecap/s-basic.jsonl',
      'claude/projects/-Users-test-Wakecap/s-drift.jsonl',
      'claude/projects/-Users-test-Wakecap/s-errors.jsonl',
      'claude/projects/-Users-test-Wakecap/s-prlink.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents.jsonl',
      'claude/projects/-Users-test-Wakecap/s-unknown.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag1.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag3.jsonl',
      'codex/sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl',
      'codex/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl',
      'codex/sessions/2026/09/02/rollout-2026-09-02T10-00-00-c0dex000-0000-0000-0000-000000000003.jsonl',
      'claude/history.jsonl',
    ]);
  });
});
