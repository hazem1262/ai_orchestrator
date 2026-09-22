import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRequest } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLiveTracker, type LiveTracker } from '../src/live/live-tracker.ts';
import { createLivenessChecker } from '../src/live/liveness.ts';
import { createRegistryWatcher } from '../src/live/registry-watcher.ts';
import { createLaunchService } from '../src/services/launch.ts';
import { createTemplateRegistry } from '../src/services/templates.ts';
import { createTestContext, FAKE_BIN_DIR, type TestContext, useTempHomes } from './helpers.ts';

/**
 * Spawns the fake CLIs in `test/bin` through a real PTY — never the real `claude` or `codex`:
 * the configured commands are absolute paths into `test/bin`, and PATH is prefixed with it too.
 * The fake `claude` only writes under `$CLAUDE_HOME`, which points at this test's temp home.
 * Every PTY is killed in `afterEach`, which then waits until its pid is gone.
 */
const homes = useTempHomes();
const saved = {
  PATH: process.env.PATH,
  CLAUDE_HOME: process.env.CLAUDE_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
let ctx: TestContext;
let tracker: LiveTracker;
let cwd: string;

const restoreEnv = (key: keyof typeof saved): void => {
  const v = saved[key];
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
};
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  process.env.PATH = `${FAKE_BIN_DIR}:${saved.PATH ?? ''}`;
  process.env.CLAUDE_HOME = homes.claudeHome;
  process.env.CODEX_HOME = homes.codexHome;
  ctx = createTestContext({ homes });
  const base = ctx.config();
  ctx.config = () => ({
    ...base,
    resumeProfile: {
      ...base.resumeProfile,
      claudeCommand: join(FAKE_BIN_DIR, 'claude'),
      codexCommand: join(FAKE_BIN_DIR, 'codex'),
    },
  });
  tracker = createLiveTracker(ctx, {
    registry: createRegistryWatcher({ dir: join(homes.claudeHome, 'sessions'), pollMs: 200 }),
    liveness: createLivenessChecker(),
    codex: { scan: async () => [] },
  });
  ctx.live = tracker;
  ctx.templates = createTemplateRegistry();
  cwd = mkdtempSync(join(tmpdir(), 'orc-int-'));
  await tracker.start();
});

afterEach(async () => {
  const pids = ctx.pty.list().map((p) => p.pid);
  for (const p of ctx.pty.list()) if (p.exitedAt === null) ctx.pty.kill(p.id, 'SIGKILL');
  await expect.poll(() => pids.filter(isAlive), { timeout: 5000, interval: 50 }).toEqual([]);
  await tracker.stop();
  ctx.dispose();
  rmSync(cwd, { recursive: true, force: true });
  restoreEnv('PATH');
  restoreEnv('CLAUDE_HOME');
  restoreEnv('CODEX_HOME');
});

describe('launch with the fake claude binary', () => {
  it('discovers the session, reaches review, and can be killed', { timeout: 20_000 }, async () => {
    const svc = createLaunchService(ctx);
    const out = await svc.launch(
      LaunchRequest.parse({ source: 'claude', projectId: null, cwd, prompt: 'do the thing' }),
    );
    const info = ctx.pty.get(out.ptyId);
    expect(info?.command).toBe(join(FAKE_BIN_DIR, 'claude'));
    expect(out.sessionId).toBe(`fake-${info?.pid}`);
    const pk = `claude:${out.sessionId}`;
    await expect.poll(() => tracker.get(pk)?.live?.status, { timeout: 8000, interval: 100 }).toBe('review');
    expect(tracker.get(pk)?.live).toMatchObject({ ownership: 'owned', ptyId: out.ptyId, stage: 'review' });
    expect(tracker.get(pk)?.lastPrompt).toBe('do the thing');

    await expect(svc.kill('claude', out.sessionId ?? '')).resolves.toEqual({ killed: 'pty' });
    await expect.poll(() => tracker.get(pk)?.live?.status, { timeout: 5000, interval: 100 }).toBe('ended');
    expect(existsSync(join(homes.claudeHome, 'sessions', `${info?.pid}.json`))).toBe(false);
    expect(readdirSync(join(homes.claudeHome, 'projects', '-fake-project'))).toEqual([
      `${out.sessionId}.jsonl`,
    ]);
  });
});

describe('launch with the fake codex binary', () => {
  it('passes the model and prompt as argv and returns no session id', { timeout: 20_000 }, async () => {
    const svc = createLaunchService(ctx);
    const prompt = 'second opinion; echo $(whoami)';
    const out = await svc.launch(
      LaunchRequest.parse({ source: 'codex', projectId: null, cwd, model: 'gpt-5.5', prompt }),
    );
    expect(out.sessionId).toBeNull();
    let seen = '';
    const handle = ctx.pty.attach(out.ptyId, (chunk) => {
      seen += chunk;
    });
    seen += handle.scrollback;
    await expect
      .poll(() => seen, { timeout: 5000, interval: 50 })
      .toContain(`args: --model gpt-5.5 -- ${prompt}`);
    handle.detach();
  });
});
