import { describe, expect, it } from 'vitest';
import { branchName, slugify, ticketFromBranch, worktreeDirName } from './branch.ts';

describe('slugify', () => {
  it('kebab-cases, drops filler words and accents', () => {
    expect(slugify('Exclude the Weekends from SLA déadline!')).toBe('exclude-weekends-sla-deadline');
  });
  it('cuts at a word boundary within 30 chars', () => {
    const s = slugify('mobile sdui mvp on device ai authored screen runtime tracer');
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s).toBe('mobile-sdui-mvp-device-ai');
  });
  it('falls back to "work"', () => {
    expect(slugify('  the / a  ')).toBe('work');
  });
});

describe('branchName', () => {
  it('uses <type>/<TICKET>-<slug> with an uppercase ticket', () => {
    expect(branchName({ type: 'feat', ticket: 'saf-1787', slug: 'Exclude weekends SLA' })).toBe(
      'feat/SAF-1787-exclude-weekends-sla',
    );
  });
  it('omits the ticket when there is none', () => {
    expect(branchName({ type: 'chore', ticket: null, slug: 'bump deps' })).toBe('chore/bump-deps');
  });
  it('rejects a ticket with unsafe characters', () => {
    expect(() => branchName({ type: 'fix', ticket: 'SAF 1; rm', slug: 'x' })).toThrow(/invalid ticket/);
  });
});

describe('worktreeDirName', () => {
  it('flattens slashes like the existing .worktrees folders', () => {
    expect(worktreeDirName('feat/ALU-1293-obs-failed-routes')).toBe('feat-ALU-1293-obs-failed-routes');
  });
});

describe('ticketFromBranch', () => {
  it('uses the project regex when given', () => {
    expect(ticketFromBranch('feat/SAF-1787-x', '\\b(SAF|ALU)-\\d+\\b')).toBe('SAF-1787');
    expect(ticketFromBranch('feat/TAN-1-x', '\\b(SAF|ALU)-\\d+\\b')).toBeNull();
  });
  it('falls back to the default regex', () => {
    expect(ticketFromBranch('docs/alu-1293-pin', null)).toBe('ALU-1293');
    expect(ticketFromBranch('master', null)).toBeNull();
  });
});
