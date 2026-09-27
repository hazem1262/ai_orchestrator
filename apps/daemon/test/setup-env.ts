import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const wstackHome = mkdtempSync(join(tmpdir(), 'orc-wstack-'));
mkdirSync(join(wstackHome, 'workflows'));
process.env.WSTACK_HOME = wstackHome;

afterAll(() => {
  rmSync(wstackHome, { recursive: true, force: true });
});
