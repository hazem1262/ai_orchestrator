import type { Goal } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { GoalEditor } from './GoalEditor.tsx';

const goal: Goal = {
  id: 'g1',
  targetType: 'session',
  targetId: 'claude:s1',
  objective: 'ship SAF-1',
  state: 'blocked',
  blockedReason: 'needs answer',
  updatedAt: 't',
};

describe('GoalEditor', () => {
  it('prefills from the server and saves an edit', async () => {
    const goalsSet = vi.fn(async (_t: string, _id: string, body: { objective: string }) => ({
      ...goal,
      objective: body.objective,
      state: 'active' as const,
      blockedReason: null,
    }));
    setApiClientForTests(
      fakeApi({
        goalsGet: vi.fn(async () => ({ goal: null, prefill: 'implement the weekend rule' })),
        goalsSet,
      }),
    );
    const user = userEvent.setup();
    renderP3(<GoalEditor targetType="session" targetId="claude:s1" />);
    const objective = await screen.findByLabelText('Goal');
    expect(objective).toHaveValue('implement the weekend rule');
    await user.clear(objective);
    await user.type(objective, 'ship it');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await waitFor(() =>
      expect(goalsSet).toHaveBeenCalledWith('session', 'claude:s1', {
        objective: 'ship it',
        state: 'active',
        blockedReason: null,
      }),
    );
  });

  it('shows the blocked reason field only when blocked', async () => {
    setApiClientForTests(
      fakeApi({ goalsGet: vi.fn(async () => ({ goal, prefill: 'x' })), goalsSet: vi.fn(async () => goal) }),
    );
    const user = userEvent.setup();
    renderP3(<GoalEditor targetType="session" targetId="claude:s1" />);
    expect(await screen.findByLabelText('Blocked reason')).toHaveValue('needs answer');
    await user.selectOptions(screen.getByLabelText('Goal state'), 'complete');
    expect(screen.queryByLabelText('Blocked reason')).toBeNull();
  });
});
