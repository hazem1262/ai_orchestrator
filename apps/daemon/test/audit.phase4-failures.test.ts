import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { wirePhase4 } from '../src/main.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';
import { stubSessions } from './stubs.ts';

let t: P3Harness | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  stop?.();
  stop = undefined;
  await t?.cleanup();
  t = undefined;
});

async function harness(): Promise<P3Harness> {
  const cfg = OrcConfig.parse({ github: { enabled: false } });
  t = await createP3Harness({ config: () => cfg, sessions: stubSessions([]) });
  stop = wirePhase4(t.ctx, { startPollers: false });
  return t;
}

const entries = (h: P3Harness, action: string) => h.ctx.audit.list({ action });

describe('phase 4 routes recorded by their service', () => {
  it('records an error entry when the body is rejected before the service runs', async () => {
    const h = await harness();
    const res = await h.request('/api/ship/commit', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    const [e, ...rest] = entries(h, 'git.commit');
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({ actor: 'user', result: 'error', params: { status: 400 } });
    expect(e?.error).toMatch(/^validation_failed/);
  });

  it('records an error entry when the route answers 404 before the service runs', async () => {
    const h = await harness();
    const res = await h.request('/api/worktrees/archive', {
      method: 'POST',
      body: { path: '/nope/wt', confirm: true },
    });
    expect(res.status).toBe(404);
    const list = entries(h, 'worktree.archive');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ target: '/nope/wt', result: 'error', params: { status: 404 } });
  });

  it('does not add a second entry when the service already recorded the failure', async () => {
    const h = await harness();
    const res = await h.request('/api/worktrees/open', {
      method: 'POST',
      body: { path: '/nope/wt', target: 'finder' },
    });
    expect(res.status).toBe(404);
    const list = entries(h, 'worktree.open');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ target: '/nope/wt', result: 'error', params: { target: 'finder' } });
  });

  it('records nothing for a confirmation prompt', async () => {
    const h = await harness();
    const res = await h.request('/api/worktrees/script', {
      method: 'POST',
      body: { path: '/nope/wt', which: 'run' },
    });
    expect(res.status).toBe(409);
    expect(entries(h, 'worktree.script')).toHaveLength(0);
  });
});
