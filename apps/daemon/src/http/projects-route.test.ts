import { ProjectConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers.ts';
import { createApp } from './app.ts';

let ctx: TestContext;
afterEach(() => ctx.dispose());

describe('GET /api/projects/:id', () => {
  it('returns the full project config', async () => {
    ctx = createTestContext();
    const app = createApp({ ctx, token: 't', port: () => 4317, env: {} });
    const headers = { 'x-orc-token': 't' };
    const res = await app.request('http://127.0.0.1:4317/api/projects/wakecap', { headers });
    expect(res.status).toBe(200);
    expect(ProjectConfig.parse(await res.json())).toMatchObject({ id: 'wakecap', openIn: 'vscode' });
    expect((await app.request('http://127.0.0.1:4317/api/projects/nope', { headers })).status).toBe(404);
  });
});
