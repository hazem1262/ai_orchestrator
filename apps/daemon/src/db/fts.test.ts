import { describe, expect, it } from 'vitest';
import { escapeLike, toFtsQuery } from './fts.ts';

describe('fts helpers', () => {
  it('builds safe prefix queries', () => {
    expect(toFtsQuery('SAF-1787 weekend')).toBe('"saf"* "1787"* "weekend"*');
    expect(toFtsQuery('"; DROP TABLE x --')).toBe('"drop"* "table"* "x"*');
    expect(toFtsQuery('مرحبا')).toBe('"مرحبا"*');
    expect(toFtsQuery('  -- ')).toBeNull();
  });

  it('neutralises FTS5 boolean/proximity keywords into literal prefix terms', () => {
    // AND / OR / NEAR are FTS5 query-language operators; toFtsQuery must quote them so they
    // are searched as literal words, never interpreted as syntax.
    expect(toFtsQuery('AND OR NEAR')).toBe('"and"* "or"* "near"*');
    expect(toFtsQuery('foo NEAR/2 bar')).toBe('"foo"* "near"* "2"* "bar"*');
  });

  it('never returns something that would be invalid/empty FTS5 syntax', () => {
    // A bare '-', a lone quote, or an unbalanced quote must not survive into the query string
    // (FTS5 MATCH throws a syntax error on malformed input, which would otherwise become a 500).
    expect(toFtsQuery('-')).toBeNull();
    expect(toFtsQuery('"')).toBeNull();
    expect(toFtsQuery('""')).toBeNull();
    expect(toFtsQuery('"unterminated')).toBe('"unterminated"*');
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });
});
