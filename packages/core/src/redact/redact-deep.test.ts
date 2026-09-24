import { describe, expect, it } from 'vitest';
import { redact, redactDeep, redactPartialTokens } from './redact.ts';

const ghp = `gh${'p_'}${'a'.repeat(36)}`;

describe('redactDeep', () => {
  it('redacts nested strings and sensitive keys, keeps other values', () => {
    const input = {
      command: `PGPASSWORD=hunter2 psql`,
      env: { PGPASSWORD: 'hunter2', client_secret: 'abc', access_token: 'zzz', tokens: 5, maxTokens: 10 },
      list: [`token ${ghp}`, 3, null, true],
      nested: { deeper: { text: 'plain' } },
    };
    const out = redactDeep(input);
    expect(out.command).toBe('PGPASSWORD=«redacted:secret» psql');
    expect(out.env).toEqual({
      PGPASSWORD: '«redacted:secret»',
      client_secret: '«redacted:secret»',
      access_token: '«redacted:secret»',
      tokens: 5,
      maxTokens: 10,
    });
    expect(out.list).toEqual(['token «redacted:github»', 3, null, true]);
    expect(out.nested.deeper.text).toBe('plain');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(input.env.PGPASSWORD).toBe('hunter2'); // input not mutated
  });
});

describe('redactPartialTokens', () => {
  it('masks token prefixes cut off by an FTS snippet', () => {
    expect(redactPartialTokens('…export GH=ghp_abc12')).toBe('…export GH=«redacted:partial»');
    expect(redactPartialTokens('key AKIAABCD…')).toBe('key «redacted:partial»…');
    expect(redactPartialTokens('slack xoxb-12')).toBe('slack «redacted:partial»');
  });

  it('composes with full redaction and leaves plain text alone', () => {
    expect(redactPartialTokens(redact(`x ${ghp}`))).toBe('x «redacted:github»');
    expect(redactPartialTokens('ran pnpm test')).toBe('ran pnpm test');
  });
});
