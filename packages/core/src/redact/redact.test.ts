import { describe, expect, it } from 'vitest';
import { REDACTION_PATTERNS, redact } from './redact.ts';

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

  it.each([
    ['GITHUB_TOKEN=abc123def456ghi789', 'GITHUB_TOKEN=«redacted:secret»'],
    ['LINEAR_API_KEY=lin_secretvalue0001', 'LINEAR_API_KEY=«redacted:secret»'],
    ['ANTHROPIC_API_KEY=sk-notarealkeyvalue', 'ANTHROPIC_API_KEY=«redacted:secret»'],
    ['SLACK_BOT_TOKEN=xoxb-notreal-000111', 'SLACK_BOT_TOKEN=«redacted:secret»'],
  ])('redacts PREFIX_TOKEN= forms: %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each(['total_token_usage: 500', '"input_tokens":1200', 'tokenCount: 5'])(
    'does not redact %s (not an actual credential assignment)',
    (input) => {
      expect(redact(input)).toBe(input);
    },
  );

  it('redacts credentials in an https URL (added https? to the scheme alternation)', () => {
    expect(redact('https://user:tok@github.com/org/repo.git')).toBe(
      'https://«redacted:credentials»@github.com/org/repo.git',
    );
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redact(`Authorization: ${jwt}`)).toBe('Authorization: «redacted:jwt»');
  });

  it('redacts a PEM private-key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redact(`key:\n${pem}`)).toBe('key:\n«redacted:pem»');
  });

  it('redacts a Google API key (AIza prefix)', () => {
    expect(redact('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456')).toBe('«redacted:gcp»');
  });

  it('redacts an npm token (npm_ prefix)', () => {
    expect(redact('npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe('«redacted:npm»');
  });

  it('redacts a Linear API key (lin_api_ prefix)', () => {
    expect(redact('lin_api_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe('«redacted:linear»');
  });

  it('gives identical output across repeated calls on the same input (no shared regex state)', () => {
    const text = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end, GITHUB_TOKEN=abc123def456ghi789';
    const first = redact(text);
    const second = redact(text);
    const third = redact(text);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('exports stateless patterns: two RegExp built from the same entry do not share lastIndex', () => {
    const entry = REDACTION_PATTERNS.find((p) => p.kind === 'github');
    expect(entry).toBeDefined();
    const re1 = new RegExp(entry?.source ?? '', entry?.flags ?? '');
    const re2 = new RegExp(entry?.source ?? '', entry?.flags ?? '');
    const text = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    expect(re1.test(text)).toBe(true);
    // re1's lastIndex has advanced past the match; re2 is a fresh instance built from the
    // same exported source/flags and still matches from the start.
    expect(re2.test(text)).toBe(true);
  });
});
