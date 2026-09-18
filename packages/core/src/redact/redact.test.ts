import { describe, expect, it } from 'vitest';
import { redact } from './redact.ts';

describe('redact', () => {
  it.each([
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end', 'token «redacted:github» end'],
    ['key github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'key «redacted:github»'],
    ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', '«redacted:anthropic»'],
    ['xoxp-1234-5678-abcd', '«redacted:slack»'],
    ['AKIAABCDEFGHIJKLMNOP', '«redacted:aws»'],
    [
      'postgres://admin:hunter2@db.internal:5432/app',
      'postgres://«redacted:credentials»@db.internal:5432/app',
    ],
    ['PGPASSWORD=hunter2 psql', 'PGPASSWORD=«redacted:secret» psql'],
    ['--password=hunter2', '--password=«redacted:secret»'],
    ['Authorization: Bearer eyJhbGciOi.xyz.abc', 'Authorization: Bearer «redacted:bearer»'],
  ])('redacts %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('leaves normal text alone', () => {
    const text = 'fix SAF-1787 in wakecap-wecare-service; ran pnpm test';
    expect(redact(text)).toBe(text);
  });
});
