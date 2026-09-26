import { describe, expect, it } from 'vitest';
import { parseStatusPorcelainZ } from './status-porcelain.ts';

describe('parseStatusPorcelainZ', () => {
  it('parses modified, untracked and renamed entries', () => {
    const out = ' M src/a.ts\0?? new file.ts\0R  src/b2.ts\0src/b.ts\0D  gone.ts\0';
    expect(parseStatusPorcelainZ(out)).toEqual([
      { path: 'src/a.ts', origPath: null, x: ' ', y: 'M', untracked: false },
      { path: 'new file.ts', origPath: null, x: '?', y: '?', untracked: true },
      { path: 'src/b2.ts', origPath: 'src/b.ts', x: 'R', y: ' ', untracked: false },
      { path: 'gone.ts', origPath: null, x: 'D', y: ' ', untracked: false },
    ]);
  });

  it('returns [] for a clean tree', () => {
    expect(parseStatusPorcelainZ('')).toEqual([]);
  });
});
