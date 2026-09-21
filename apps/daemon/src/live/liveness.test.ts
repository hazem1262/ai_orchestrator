import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import {
  createLivenessChecker,
  defaultExec,
  type ExecFn,
  findRegistryEntry,
  isPidAlive,
  parseLstart,
  readClaudeRegistry,
} from './liveness.ts';

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

describe('parseLstart', () => {
  it('parses the `ps` lstart column, including its double-space day padding', () => {
    // The registry writes exactly what `ps` prints, which pads single-digit days with a space.
    expect(parseLstart('Mon Sep  1 09:00:00 2026')).toBe(new Date(2026, 8, 1, 9, 0, 0).getTime());
    expect(parseLstart('Tue Sep 15 23:59:59 2026')).toBe(new Date(2026, 8, 15, 23, 59, 59).getTime());
  });

  it('returns null for anything that is not an lstart', () => {
    expect(parseLstart('')).toBeNull();
    expect(parseLstart('2026-09-01T09:00:00Z')).toBeNull();
    expect(parseLstart('Mon Zzz  1 09:00:00 2026')).toBeNull();
  });
});

describe('createLivenessChecker', () => {
  const START = 'Mon Sep  1 09:00:00 2026';
  const OTHER = 'Tue Sep  2 11:22:33 2026';
  const psLine = (pid: number, lstart: string) => `  ${pid}     1 ${lstart} claude\n`;
  const execFor = (lstart: string | null): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const pid = Number(args[args.length - 1]);
      return lstart === null ? { stdout: '', exitCode: 1 } : { stdout: psLine(pid, lstart), exitCode: 0 };
    };
    return { exec, calls };
  };

  it('accepts a pid whose start time matches procStart', async () => {
    const { exec, calls } = execFor(START);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, START)).toBe(true);
    expect(calls).toEqual([['ps', '-o', 'pid=,ppid=,lstart=,command=', '-p', '41001']]);
  });

  it('rejects a recycled pid whose start time does not match procStart', async () => {
    // The whole point of the second argument: the registry file outlives its process, so an
    // unrelated program that inherits the pid must not keep a dead session on the board.
    const { exec } = execFor(OTHER);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, START)).toBe(false);
  });

  it('degrades to the bare pid check when procStart is null', async () => {
    const { exec, calls } = execFor(OTHER);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, null)).toBe(true);
    expect(await c.isAlive(41001)).toBe(true);
    expect(calls).toEqual([]); // no `ps` at all: there is nothing to compare against
  });

  it('degrades to the bare pid check when procStart is in an unrecognised format', async () => {
    const { exec, calls } = execFor(OTHER);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, '2026-09-01T09:00:00Z')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('degrades to the bare pid check when `ps` succeeds but its output does not parse', async () => {
    const exec: ExecFn = async () => ({ stdout: 'PID  STARTED\nnot a ps line\n', exitCode: 0 });
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, START)).toBe(true);
  });

  it('reports a dead pid without running `ps`', async () => {
    const { exec, calls } = execFor(START);
    const c = createLivenessChecker({ exec, pidAlive: () => false });
    expect(await c.isAlive(41001, START)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats a non-zero `ps` exit as dead', async () => {
    const { exec } = execFor(null);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, START)).toBe(false);
  });

  it('caches a verdict for cacheMs and re-runs `ps` once it expires', async () => {
    const { exec, calls } = execFor(START);
    let t = 1000;
    const c = createLivenessChecker({ exec, pidAlive: () => true, now: () => t, cacheMs: 2000 });
    expect(await c.isAlive(41001, START)).toBe(true);
    t = 2500;
    expect(await c.isAlive(41001, START)).toBe(true);
    expect(calls).toHaveLength(1);
    t = 3001;
    expect(await c.isAlive(41001, START)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('defaults to the real process table', async () => {
    const c = createLivenessChecker();
    expect(await c.isAlive(2 ** 22 + 12345, null)).toBe(false);
    // Never kills, never signals: this only reads `ps` for a pid we already know is ours.
    const spy = vi.spyOn(process, 'kill');
    expect(await c.isAlive(process.pid, null)).toBe(true);
    expect(spy.mock.calls.every(([, sig]) => sig === 0)).toBe(true);
    spy.mockRestore();
  });
});
