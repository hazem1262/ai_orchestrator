import { describe, expect, it } from 'vitest';
import { encodePaste, sendText } from './paste.ts';

describe('sendText', () => {
  it('wraps text in bracketed paste', () => {
    expect(encodePaste('hi\nthere')).toBe('\x1b[200~hi\nthere\x1b[201~');
  });

  it('writes paste then carriage return', async () => {
    const writes: string[] = [];
    await sendText((d) => writes.push(d), 'yes', { submitDelayMs: 0 });
    expect(writes).toEqual(['\x1b[200~yes\x1b[201~', '\r']);
  });
});
