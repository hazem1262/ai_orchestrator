import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { SecretsReport } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app.ts';
import { e2eDaemonConfig } from './e2e-config.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { makeTempHomes, type TempHomes } from './homes.ts';

// The secrets scanner reads through `node:fs/promises`. Any read under the developer's real home
// is refused (ENOENT) and recorded, so these tests never open a real file and still see which
// paths the scanner tried to reach.
const realHomeReads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>();
  const { homedir: realHome } = await import('node:os');
  const inRealHome = (p: unknown) => {
    const h = realHome();
    return typeof p === 'string' && (p === h || p.startsWith(`${h}/`));
  };
  const guard =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      if (inRealHome(a[0])) {
        realHomeReads.push(`${name} ${String(a[0])}`);
        return Promise.reject(Object.assign(new Error(`ENOENT: ${name} blocked`), { code: 'ENOENT' }));
      }
      return fn(...a);
    };
  const guarded = {
    ...fsp,
    stat: guard('stat', fsp.stat),
    realpath: guard('realpath', fsp.realpath),
    readdir: guard('readdir', fsp.readdir),
    readFile: guard('readFile', fsp.readFile),
  };
  return { ...guarded, default: guarded };
});

const TOKEN = 'c'.repeat(64);

async function scanPaths(ctx: TestContext): Promise<string[]> {
  const app = createApp({ ctx, token: TOKEN, port: () => 4317, env: {} });
  const res = await app.request('http://127.0.0.1:4317/api/safety/secrets', {
    headers: { 'x-orc-token': TOKEN },
  });
  expect(res.status).toBe(200);
  const report = (await res.json()) as SecretsReport;
  return report.files.map((f) => f.path);
}

function expectOutsideRealHome(paths: string[]): void {
  const home = `${homedir()}${sep}`;
  expect(paths.filter((p) => p === homedir() || p.startsWith(home))).toEqual([]);
  expect(realHomeReads).toEqual([]);
}

describe('test daemons never scan secrets under the real home', () => {
  let homes: TempHomes;
  let ctx: TestContext | null = null;
  beforeEach(() => {
    realHomeReads.length = 0;
    homes = makeTempHomes();
  });
  afterEach(() => {
    ctx?.dispose();
    ctx = null;
    homes.cleanup();
  });

  it('the e2e fixture daemon resolves no secret-scan path under the real home', async () => {
    const cfg = e2eDaemonConfig({ port: 4399, work: join(homes.root, 'work', 'Wakecap'), agnc: false });
    ctx = createTestContext({ homes, config: () => cfg });
    expectOutsideRealHome(await scanPaths(ctx));
  });

  it('createTestContext resolves no secret-scan path under the real home', async () => {
    ctx = createTestContext({ homes });
    expectOutsideRealHome(await scanPaths(ctx));
  });
});
