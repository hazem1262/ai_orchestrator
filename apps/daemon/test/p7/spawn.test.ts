import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/services/errors.ts';
import {
  assertOwnedCapacity,
  spawnClaudeSession,
  spawnCodexSession,
} from '../../src/services/launch/spawn.ts';
import { createFakePty, fakeProjects, testConfig } from '../fakes/phase7.ts';
import { createTestContext } from '../helpers.ts';

describe('spawn helpers', () => {
  it('spawns claude with a fixed session id and the prompt after --', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({
      config: () => cfg,
      pty,
      projects: fakeProjects(cfg),
      launcher: undefined,
    });
    const r = spawnClaudeSession(ctx, {
      cwd: '/tmp',
      prompt: '--looks-like-a-flag',
      model: 'claude-sonnet-5',
      args: ['--permission-mode', 'plan'],
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(r.sessionPk).toBe('claude:11111111-1111-4111-8111-111111111111');
    expect(pty.spawned[0]?.args).toEqual([
      '--permission-mode',
      'plan',
      '--model',
      'claude-sonnet-5',
      '--session-id',
      '11111111-1111-4111-8111-111111111111',
      '--',
      '--looks-like-a-flag',
    ]);
    expect(pty.spawned[0]?.sessionPk).toBe(r.sessionPk);
    ctx.dispose();
  });

  it('spawns codex without a session pk', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({
      config: () => cfg,
      pty,
      projects: fakeProjects(cfg),
      launcher: undefined,
    });
    const r = spawnCodexSession(ctx, { cwd: '/tmp', prompt: 'fix it', model: 'gpt-5.5-codex' });
    expect(r.sessionPk).toBeNull();
    expect(pty.spawned[0]?.command).toBe('codex');
    expect(pty.spawned[0]?.args).toEqual(['-m', 'gpt-5.5-codex', '--', 'fix it']);
    ctx.dispose();
  });

  it('enforces the per-project owned-session cap', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({
      config: () => cfg,
      pty,
      projects: fakeProjects(cfg),
      launcher: undefined,
    });
    for (let i = 0; i < 3; i++) spawnClaudeSession(ctx, { cwd: '/tmp', prompt: 'x', args: [] });
    expect(() => assertOwnedCapacity(ctx, 'wakecap')).toThrow(ServiceError);
    pty.exit('pty-1');
    expect(() => assertOwnedCapacity(ctx, 'wakecap')).not.toThrow();
    expect(() => assertOwnedCapacity(ctx, 'wakecap', 2)).toThrow(ServiceError);
    ctx.dispose();
  });
});
