import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchRequest } from '@orc/api-contract';
import type { Recap } from '@orc/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createFakePty } from '../../../test/fake-pty.ts';
import { FAKE_CLAUDE } from '../../../test/homes.ts';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { ServiceError } from '../errors.ts';
import { createLaunchService, LaunchError } from '../launch.ts';
import type { RecapService } from '../recap/recap.ts';
import { createStreamService } from '../streams/streams.ts';
import { createHandoffService } from './handoff.ts';

// Safety: no test here may run the real `claude` binary or reach the Anthropic API.
// - Every HandoffService gets an injected fake RecapService (`findCached`/`runLlm` only); the
//   context's own recap engines are never called.
// - "Resume fresh" goes through either a recording launcher stub or the shipped
//   `createLaunchService` on a `createFakePty()` PTY manager (it spawns no OS process), with the
//   resume profile's `claudeCommand` pinned to the fake `test/bin/claude` (FAKE_CLAUDE).
// - ANTHROPIC_API_KEY is removed from the process for the whole file.
let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orc-handoff-'));
  // The stream service scans $WSTACK_HOME/workflows; point it at an empty temp dir.
  vi.stubEnv('WSTACK_HOME', join(root, 'wstack'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fakeRecaps(llm: 'ok' | 'fail' | 'bad', prompts: string[]): RecapService {
  return {
    findCached: () => null,
    runLlm: async (_k: string, key: string, _o: number, prompt: string): Promise<Recap> => {
      prompts.push(prompt);
      if (llm === 'fail') throw new ServiceError('over_budget', 409, 'budget');
      const text =
        llm === 'bad'
          ? 'sorry'
          : '{"status":"ready_for_review","summary":"Done X","nextSteps":["Merge"],"blockers":[]}';
      return {
        id: 'r',
        kind: 'handoff',
        targetKey: key,
        transcriptOffset: 1,
        model: 'm',
        engine: 'claude-cli',
        text,
        costUsd: 0.1,
        inputTokensApprox: 1,
        createdAt: 't',
      };
    },
  } as unknown as RecapService;
}

function setup(llm: 'ok' | 'fail' | 'bad' = 'ok') {
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    recap: 'Recap first line',
    filesTouched: ['/w/a.ts'],
    startCwd: '/Users/test/Wakecap',
    prs: [{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1' }],
  });
  const events = {
    'claude:s1': [
      ev({ seq: 1, ts: 't', kind: 'tool_call', tool: 'Bash', input: { command: 'pnpm test' } }),
      ev({ seq: 2, ts: 't', kind: 'tool_result', text: 'SECRET_OUT' }),
    ],
  };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1], events } });
  const prompts: string[] = [];
  const recaps = fakeRecaps(llm, prompts);
  const launches: LaunchRequest[] = [];
  t.ctx.launcher = {
    launch: async (req) => {
      launches.push(req);
      return { ptyId: 'pty-9', sessionId: null };
    },
    kill: async () => ({ killed: 'pty' as const }),
    ownedCount: () => 0,
  };
  const svc = createHandoffService(t.ctx, { recaps, now: () => new Date('2026-09-17T10:00:00.000Z') });
  return { ...t, svc, prompts, launches };
}

describe('handoff service', () => {
  it('combines structured evidence with the LLM summary', async () => {
    const { svc, prompts } = setup();
    const h = await svc.generate('claude:s1');
    expect(h).toMatchObject({
      sessionId: 'claude:s1',
      status: 'ready_for_review',
      summary: 'Done X',
      nextSteps: ['Merge'],
      blockers: [],
      evidence: ['PR: https://github.com/o/r/pull/1', 'Ran: `pnpm test`'],
      files: ['/w/a.ts'],
      links: ['https://github.com/o/r/pull/1', 'ticket:SAF-1'],
      createdAt: '2026-09-17T10:00:00.000Z',
    });
    expect(prompts[0]).toContain('Ran: `pnpm test`');
    expect(prompts[0]).not.toContain('SECRET_OUT');
    expect(svc.latest('claude:s1')).toEqual(h);
    expect(svc.get(h.id)).toEqual(h);
    expect(svc.toMarkdown(h)).toContain('# Handoff — ready_for_review');
  });

  it('falls back to structured data when the LLM is unavailable or returns junk', async () => {
    const a = setup('fail');
    a.ctx.goals = {
      get: () => ({
        id: 'g',
        targetType: 'session',
        targetId: 'claude:s1',
        objective: 'o',
        state: 'blocked',
        blockedReason: 'needs answer',
        updatedAt: 't',
      }),
    } as unknown as NonNullable<typeof a.ctx.goals>;
    expect(await a.svc.generate('claude:s1')).toMatchObject({
      status: 'blocked',
      summary: 'Recap first line',
      blockers: ['needs answer'],
      nextSteps: [],
    });
    const b = setup('bad');
    expect(await b.svc.generate('claude:s1')).toMatchObject({
      status: 'unknown',
      summary: 'Recap first line',
    });
    await expect(b.svc.generate('claude:none')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips the LLM when recaps are disabled for the project', async () => {
    const t = setup();
    t.ctx.updateConfig?.((c) => ({
      ...c,
      projects: c.projects.map((p) => ({ ...p, features: { ...p.features, recaps: false } })),
    }));
    await t.svc.generate('claude:s1');
    expect(t.prompts).toEqual([]);
  });

  it('resumes fresh through the launcher with the handoff prompt', async () => {
    const { svc, launches } = setup();
    const h = await svc.generate('claude:s1');
    expect(await svc.resumeFresh(h.id)).toEqual({ ptyId: 'pty-9' });
    expect(launches[0]).toMatchObject({
      source: 'claude',
      projectId: 'wakecap',
      cwd: '/Users/test/Wakecap',
      planApproval: false,
    });
    expect(launches[0]?.prompt.startsWith('You are continuing')).toBe(true);
    await expect(svc.resumeFresh('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('handoff service with the shipped launcher', () => {
  // The real `createLaunchService` on a fake PTY manager: it records the spawn and starts no
  // process. The configured claude command is the fake `test/bin/claude`, never the real CLI.
  function launcherSetup(maxConcurrentOwned?: number) {
    const cwd = join(root, 'Wakecap');
    const pty = createFakePty();
    const s1 = makeSession({
      id: 's1',
      tickets: ['SAF-1'],
      recap: 'Recap first line',
      startCwd: cwd,
      cwds: [cwd],
    });
    const t = makeP5Context({
      overrides: { pty },
      config: withWakecap(cwd, maxConcurrentOwned === undefined ? {} : { maxConcurrentOwned }),
      data: { sessions: [s1] },
    });
    mkdirSync(cwd, { recursive: true });
    t.ctx.live = createFakeLive();
    t.ctx.launcher = createLaunchService(t.ctx, { discoverTimeoutMs: 1 });
    const prompts: string[] = [];
    const svc = createHandoffService(t.ctx, {
      recaps: fakeRecaps('ok', prompts),
      now: () => new Date('2026-09-17T10:00:00.000Z'),
    });
    return { ...t, svc, pty, cwd };
  }

  it('spawns the configured (fake) claude in the session cwd with the resume prompt', async () => {
    const { ctx, svc, pty, cwd } = launcherSetup();
    expect(ctx.config().resumeProfile.claudeCommand).toBe(FAKE_CLAUDE);
    const h = await svc.generate('claude:s1');
    expect(await svc.resumeFresh(h.id)).toEqual({ ptyId: 'pty-1' });
    expect(pty.spawned).toHaveLength(1);
    expect(pty.spawned[0]).toMatchObject({ command: FAKE_CLAUDE, cwd });
    const prompt = pty.spawned[0]?.args.at(-1) ?? '';
    expect(prompt.startsWith('You are continuing')).toBe(true);
    expect(prompt).toContain(svc.toMarkdown(h));
  });

  it("applies P2's per-project concurrency cap", async () => {
    const { svc, pty } = launcherSetup(1);
    const h = await svc.generate('claude:s1');
    await svc.resumeFresh(h.id);
    const err = await svc.resumeFresh(h.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LaunchError);
    expect(err).toMatchObject({ status: 429, code: 'concurrency_limit' });
    expect(pty.spawned).toHaveLength(1);
  });
});

describe('work stream detail', () => {
  it("returns the latest handoff among the ticket's sessions", async () => {
    const s1 = makeSession({ id: 's1', tickets: ['SAF-1'], recap: 'one' });
    const s2 = makeSession({ id: 's2', tickets: ['SAF-1'], recap: 'two' });
    const other = makeSession({ id: 's3', tickets: ['SAF-2'], recap: 'three' });
    const t = makeP5Context({
      config: withWakecap('/Users/test/Wakecap'),
      data: { sessions: [s1, s2, other] },
    });
    let nowMs = Date.parse('2026-09-17T10:00:00.000Z');
    const handoffs = createHandoffService(t.ctx, {
      recaps: fakeRecaps('ok', []),
      now: () => new Date(nowMs),
    });
    t.ctx.handoffs = handoffs;
    t.ctx.streams = createStreamService(t.ctx, {
      prs: { list: () => [] },
      meter: { checkBudget: () => ({ ok: true, pct: 0, limitUsd: null }) },
      now: () => new Date('2026-09-17T12:00:00.000Z'),
    });
    expect((await t.ctx.streams.get('SAF-1'))?.handoff).toBeNull();

    await handoffs.generate('claude:s1');
    nowMs += 60_000;
    const newest = await handoffs.generate('claude:s2');
    nowMs += 60_000;
    await handoffs.generate('claude:s3');

    expect((await t.ctx.streams.get('SAF-1'))?.handoff).toEqual(newest);
  });
});
