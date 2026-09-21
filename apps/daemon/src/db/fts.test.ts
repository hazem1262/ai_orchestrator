import { describe, expect, it } from 'vitest';
import { escapeLike, ftsPrefixToken, toFtsQuery } from './fts.ts';

describe('fts helpers', () => {
  // Fix round 2: only the last (still-being-typed) token is a prefix match; every earlier token
  // — one the user has already finished typing — is an exact term. This is what bounds query
  // cost (see fts.ts's doc comment / task-19-report.md's "Fix round 2"): at most one wide-fan-out
  // prefix per query instead of every token independently fanning out.
  it('builds safe prefix queries: only the last token is a prefix match', () => {
    expect(toFtsQuery('SAF-1787 weekend')).toBe('"saf" "1787" "weekend"*');
    expect(toFtsQuery('"; DROP TABLE x --')).toBe('"drop" "table" "x"');
    expect(toFtsQuery('مرحبا')).toBe('"مرحبا"*');
    expect(toFtsQuery('  -- ')).toBeNull();
  });

  it('does not prefix-match a final token shorter than 3 characters', () => {
    // A 1-2 character prefix is close to a full-dictionary scan and almost never a useful search
    // on its own (see MIN_PREFIX_LEN's doc comment) — matched exactly instead.
    expect(toFtsQuery('SAF-1')).toBe('"saf" "1"');
    expect(toFtsQuery('a')).toBe('"a"');
    expect(toFtsQuery('ab')).toBe('"ab"');
    expect(toFtsQuery('abc')).toBe('"abc"*');
  });

  it('neutralises FTS5 boolean/proximity keywords into literal exact/prefix terms', () => {
    // AND / OR / NEAR are FTS5 query-language operators; toFtsQuery must quote them so they
    // are searched as literal words, never interpreted as syntax.
    expect(toFtsQuery('AND OR NEAR')).toBe('"and" "or" "near"*');
    expect(toFtsQuery('foo NEAR/2 bar')).toBe('"foo" "near" "2" "bar"*');
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

  it('exposes the prefix-matched token (or null) for the wide-fan-out cardinality guard', () => {
    expect(ftsPrefixToken('SAF-1787 weekend')).toBe('weekend');
    expect(ftsPrefixToken('SAF-1')).toBeNull(); // last token '1' is below MIN_PREFIX_LEN
    expect(ftsPrefixToken('notif')).toBe('notif');
    expect(ftsPrefixToken('')).toBeNull();
    expect(ftsPrefixToken('   ')).toBeNull();
  });
});
