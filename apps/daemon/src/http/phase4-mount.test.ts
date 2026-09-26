import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createP3Harness, type P3Harness } from '../../test/p3-harness.ts';
import { stubSessions } from '../../test/stubs.ts';
import { wirePhase4 } from '../main.ts';

let harness: P3Harness | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  stop?.();
  stop = undefined;
  await harness?.cleanup();
  harness = undefined;
});

describe('phase 4 mount', () => {
  it('serves phase 4 routes behind the token', async () => {
    const cfg = OrcConfig.parse({ github: { enabled: false } });
    const h = await createP3Harness({ config: () => cfg, sessions: stubSessions([]) });
    harness = h;
    stop = wirePhase4(h.ctx, { startPollers: false });
    expect((await h.request('/api/worktrees', { headers: { 'x-orc-token': 'wrong' } })).status).toBe(401);
    const ok = await h.request('/api/worktrees');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
    const gh = await h.request('/api/github/status');
    expect(await gh.json()).toEqual({ status: 'disabled' });
  });
});
