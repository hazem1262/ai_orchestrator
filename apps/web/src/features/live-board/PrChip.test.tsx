import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { PrChip } from './PrChip.tsx';

describe('PrChip', () => {
  it('shows live PR state and checks', async () => {
    const api = createFakeApi({
      githubPr: async () => ({
        pr: { repo: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12' },
        state: 'open',
        title: 't',
        checks: 'failure',
        review: 'approved',
        updatedAt: 'x',
        headRef: null,
        failedChecks: ['unit'],
      }),
    });
    renderWithProviders(<PrChip pr={{ repo: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12' }} />, {
      api,
    });
    const chip = await screen.findByRole('link', { name: 'PR #12: open, checks failure, review approved' });
    expect(chip.textContent).toBe('#12 ✗');
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/12');
  });

  it('falls back to the plain number while loading', () => {
    const api = createFakeApi({ githubPr: () => new Promise(() => {}) });
    renderWithProviders(<PrChip pr={{ repo: 'o/r', number: 13, url: 'u' }} />, { api });
    expect(screen.getByRole('link').textContent).toBe('#13');
  });
});
