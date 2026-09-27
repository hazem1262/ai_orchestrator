import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWstackHome } from '../src/services/wstack.ts';
import { makeTempHomes, type TempHomes } from './homes.ts';

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
