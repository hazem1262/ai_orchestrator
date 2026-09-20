import { afterEach, beforeEach } from 'vitest';
import { makeTempHomes, type TempHomes } from './homes.ts';

export * from './homes.ts';

/** Fresh temp copies of the fixture homes for every test in the calling `describe`. */
export function useTempHomes(): TempHomes {
  const holder = {} as TempHomes;
  beforeEach(() => {
    Object.assign(holder, makeTempHomes());
  });
  afterEach(() => {
    holder.cleanup();
  });
  return holder;
}
