import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { defaultExec, findRegistryEntry, isPidAlive, readClaudeRegistry } from './liveness.ts';

describe('liveness', () => {
  const homes = useTempHomes();

  it('checks pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('reads registry files and ignores keys and partial writes', () => {
    const dir = join(homes.claudeHome, 'sessions');
    writeFileSync(join(dir, '41001.abcdef.key'), 'SECRET');
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-dr');
    const entries = readClaudeRegistry(homes.claudeHome);
    expect(entries.map((e) => e.pid)).toEqual([41001]);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(readClaudeRegistry(join(homes.root, 'missing'))).toEqual([]);
  });

  it('finds a session entry and reports liveness', () => {
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => true)).toMatchObject({
      pid: 41001,
      alive: true,
    });
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => false)).toMatchObject({
      pid: 41001,
      alive: false,
    });
    expect(findRegistryEntry(homes.claudeHome, 's-drift', () => true)).toBeNull();
  });
});

describe('defaultExec', () => {
  it('runs a harmless command and captures stdout', async () => {
    const r = await defaultExec('echo', ['hello']);
    expect(r).toEqual({ stdout: 'hello\n', exitCode: 0 });
  });

  it('reports a non-zero exit instead of rejecting', async () => {
    const r = await defaultExec('sh', ['-c', 'exit 3']);
    expect(r.exitCode).toBe(3);
  });

  it('reports a missing binary instead of rejecting', async () => {
    const r = await defaultExec('orc-definitely-not-a-real-binary', []);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});
