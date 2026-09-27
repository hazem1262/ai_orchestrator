import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWstackHome } from '../src/services/wstack.ts';
import { e2eRoot, makeTempHomes, type TempHomes } from './homes.ts';

let homes: TempHomes | undefined;
afterEach(() => {
  homes?.cleanup();
  homes = undefined;
});

describe('test homes', () => {
  it('give a daemon started on them an empty temp WSTACK_HOME', () => {
    homes = makeTempHomes();
    expect(homes.env.WSTACK_HOME).toBe(join(homes.root, 'wstack'));
    expect(existsSync(join(homes.root, 'wstack', 'workflows'))).toBe(true);
  });

  it('never let a test read the real ~/.wstack', () => {
    const home = resolveWstackHome();
    expect(home).not.toBe(join(homedir(), '.wstack'));
    expect(existsSync(join(home, 'workflows'))).toBe(true);
  });
});

describe('e2eRoot', () => {
  it('is unique per run unless ORC_E2E_ROOT pins it', () => {
    const a = e2eRoot({});
    const b = e2eRoot({});
    try {
      expect(a).not.toBe(b);
      expect(existsSync(a) && existsSync(b)).toBe(true);
      expect(e2eRoot({ ORC_E2E_ROOT: '/tmp/pinned-orc-e2e' })).toBe('/tmp/pinned-orc-e2e');
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
