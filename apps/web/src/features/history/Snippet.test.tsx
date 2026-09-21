import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Snippet } from './Snippet.tsx';

describe('Snippet', () => {
  it('highlights marked ranges', () => {
    const { container } = render(<Snippet text="…check the ⟦notification⟧ service ⟦tests⟧" />);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'notification',
      'tests',
    ]);
    expect(container.textContent).toBe('…check the notification service tests');
  });

  it('renders unmarked and unbalanced text as-is', () => {
    const { container } = render(<Snippet text="plain ⟦open" />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.textContent).toBe('plain open');
  });
});
