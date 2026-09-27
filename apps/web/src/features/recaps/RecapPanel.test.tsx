import { ApiRequestError } from '@orc/api-contract';
import type { Recap } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { RecapPanel } from './RecapPanel.tsx';

const recap: Recap = {
  id: 'r1',
  kind: 'session',
  targetKey: 'claude:s1',
  transcriptOffset: 10,
  model: 'claude-sonnet-5',
  engine: 'claude-cli',
  text: 'Fixed the SLA rule.\n**What to check:**\n- weekend edge cases',
  costUsd: 0.21,
  inputTokensApprox: 900,
  createdAt: '2026-09-18T09:00:00.000Z',
};

describe('RecapPanel', () => {
  it('shows the recap with its model and cost, and can regenerate', async () => {
    const recapsRunSession = vi.fn(async () => ({
      text: 'new',
      costUsd: 0.3,
      model: 'claude-sonnet-5',
      cached: false,
    }));
    setApiClientForTests(
      fakeApi({
        recapsGetSession: vi.fn(async () => recap),
        recapsRunSession,
        recapsSpend: vi.fn(async () => ({ spentUsd: 1.5, budgetUsd: 20 })),
      }),
    );
    const user = userEvent.setup();
    renderP3(<RecapPanel source="claude" id="s1" />);
    expect(await screen.findByText(/Fixed the SLA rule\./)).toBeTruthy();
    expect(screen.getByText(/claude-sonnet-5 · \$0\.21/)).toBeTruthy();
    expect(screen.getByText(/\$1\.50 of \$20\.00 this month/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Recap now' }));
    expect(recapsRunSession).toHaveBeenCalledWith('claude', 's1', true);
  });

  it('explains a refusal from the API', async () => {
    setApiClientForTests(
      fakeApi({
        recapsGetSession: vi.fn(async () => null),
        recapsSpend: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 20 })),
        recapsRunSession: vi.fn(async () =>
          Promise.reject(new ApiRequestError(409, 'over_budget', 'no', undefined)),
        ),
      }),
    );
    const user = userEvent.setup();
    renderP3(<RecapPanel source="claude" id="s1" />);
    await user.click(await screen.findByRole('button', { name: 'Recap now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The monthly recap budget is used up.');
  });
});
