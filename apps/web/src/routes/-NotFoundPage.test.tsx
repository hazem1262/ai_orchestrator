import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NotFoundPage } from './-NotFoundPage.tsx';

describe('NotFoundPage', () => {
  it('shows a way back to Live instead of a bare 404', () => {
    render(<NotFoundPage />);
    expect(screen.getByText('Page not found')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Go to Live' });
    expect(link.getAttribute('href')).toBe('/live');
  });
});
