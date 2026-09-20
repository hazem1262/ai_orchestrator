import { describe, expect, it } from 'vitest';
import { formatCost, formatDateTime, formatDuration, formatTokens, shortenPath } from './format.ts';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(420_000)).toBe('7m');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('formats cost and tokens', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(1234.5)).toBe('$1,234.50');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('formats local date-times and paths', () => {
    expect(formatDateTime(new Date(2026, 8, 1, 9, 5).toISOString())).toBe('2026-09-01 09:05');
    expect(formatDateTime('not a date')).toBe('—');
    expect(shortenPath('/Users/test/Wakecap/Backend')).toBe('~/Wakecap/Backend');
    expect(shortenPath('/tmp/x')).toBe('/tmp/x');
  });
});
