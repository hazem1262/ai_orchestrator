import { describe, expect, it } from 'vitest';
import { allowedHosts, allowedOrigins, isLoopback, tokenMatches } from './auth.ts';

describe('auth helpers', () => {
  it('allows loopback hosts on the daemon port, plus Vite in dev', () => {
    expect(allowedHosts(4317, {})).toEqual(['127.0.0.1:4317', 'localhost:4317']);
    expect(allowedHosts(4317, { ORC_DEV: '1' })).toEqual([
      '127.0.0.1:4317',
      'localhost:4317',
      '127.0.0.1:5173',
      'localhost:5173',
    ]);
    expect(allowedOrigins(4317, {})).toEqual(['http://127.0.0.1:4317', 'http://localhost:4317']);
  });

  it('compares tokens safely', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });

  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
