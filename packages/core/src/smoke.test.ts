import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from './index.ts';

describe('core smoke', () => {
  it('exports a version', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });
});
