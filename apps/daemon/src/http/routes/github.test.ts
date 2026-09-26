import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { stubSessions } from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { githubRoutes } from './github.ts';

let fake: FakeGh | undefined;
const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  fake?.restore();
  fake = undefined;
});

function setup(enabled = true) {
  fake?.restore();
  const f = useFakeGh();
  fake = f;
  const cfg = OrcConfig.parse({ github: { enabled } });
  const ctx = createTestContext({ config: () => cfg, sessions: stubSessions([]) });
  contexts.push(ctx);
  ctx.github = createGithubConnector(ctx);
  f.setPr({
    repo: 'example-org/temp-repo',
    number: 3,
    url: 'https://github.com/example-org/temp-repo/pull/3',
    title: 'SAF-3',
    state: 'OPEN',
    headRefName: 'feat/SAF-3-x',
    baseRefName: 'main',
    body: '',
    updatedAt: '2026-09-17T10:00:00Z',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [],
  });
  return { app: githubRoutes(ctx), fake: f };
}

describe('github routes', () => {
  it('reports status, including disabled', async () => {
    expect(await (await setup().app.request('/github/status')).json()).toEqual({ status: 'ok' });
    expect(await (await setup(false).app.request('/github/status')).json()).toEqual({ status: 'disabled' });
  });

  it('returns one PR and my PRs', async () => {
    const { app } = setup();
    const one = await app.request('/github/pr?repo=example-org/temp-repo&number=3');
    expect(((await one.json()) as { review: string }).review).toBe('approved');
    const mine = await app.request('/github/prs/mine');
    expect(((await mine.json()) as unknown[]).length).toBe(1);
    expect((await app.request('/github/pr?repo=bad&number=x')).status).toBe(400);
  });

  it('maps gh failures to 503', async () => {
    const { app, fake } = setup();
    fake.setState({ authed: false });
    const r = await app.request('/github/prs/mine');
    expect(r.status).toBe(503);
  });
});
