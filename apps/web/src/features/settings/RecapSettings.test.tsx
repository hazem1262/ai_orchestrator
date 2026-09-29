import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { RecapSettings } from './RecapSettings.tsx';

const recaps = {
  enabled: false,
  trigger: 'manual' as const,
  engine: 'claude-cli' as const,
  autoModel: 'claude-haiku-4-5',
  onDemandModel: 'claude-sonnet-5',
  monthlyBudgetUsd: 20,
  maxInputTokens: 30000,
  minPrompts: 2,
  language: 'en',
  promptTemplate: null,
  idleMinutes: 10,
  excludeProjectIds: [],
  dailyProjectIds: ['wakecap'],
};

function api(settingsUpdate = vi.fn(async () => ({ recaps }) as never)) {
  return fakeApi({
    settingsGet: vi.fn(async () => ({ recaps }) as never),
    settingsUpdate,
    recapsSpend: vi.fn(async () => ({ spentUsd: 3, budgetUsd: 20 })),
  });
}

describe('RecapSettings', () => {
  it('saves every recap option in one section update', async () => {
    const settingsUpdate = vi.fn(async () => ({ recaps: { ...recaps, enabled: true } }) as never);
    setApiClientForTests(api(settingsUpdate));
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    await user.click(await screen.findByLabelText('Enable automatic recaps'));
    await user.selectOptions(screen.getByLabelText('Trigger'), 'on_idle');
    await user.click(screen.getByRole('radio', { name: 'Anthropic API' }));
    await user.clear(screen.getByLabelText('Monthly budget (USD)'));
    await user.type(screen.getByLabelText('Monthly budget (USD)'), '35');
    await user.clear(screen.getByLabelText('Output language'));
    await user.type(screen.getByLabelText('Output language'), 'ar');
    await user.click(screen.getByRole('button', { name: 'Save recap settings' }));
    await waitFor(() =>
      expect(settingsUpdate).toHaveBeenCalledWith({
        recaps: {
          ...recaps,
          enabled: true,
          trigger: 'on_idle',
          engine: 'anthropic-api',
          monthlyBudgetUsd: 35,
          language: 'ar',
        },
      }),
    );
    expect(screen.getByText(/\$3\.00 of \$20\.00 this month/)).toBeTruthy();
  });

  it('edits and resets the prompt template', async () => {
    const settingsUpdate = vi.fn(async () => ({ recaps }) as never);
    setApiClientForTests(api(settingsUpdate));
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    const box = await screen.findByLabelText('Prompt template');
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('What to check'));
    await user.type(box, 'Custom {{{{digest}}');
    await user.click(screen.getByRole('button', { name: 'Save recap settings' }));
    await waitFor(() =>
      expect(settingsUpdate).toHaveBeenCalledWith({
        recaps: { ...recaps, promptTemplate: 'Custom {{digest}}' },
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Reset to the default prompt' }));
    expect(screen.getByLabelText('Prompt template')).toHaveValue('');
  });

  it('warns that the API engine needs a key', async () => {
    setApiClientForTests(api());
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    const apiEngine = await screen.findByRole('radio', { name: 'Anthropic API' });
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(apiEngine);
    expect(screen.getByRole('status').textContent).toMatch(/ANTHROPIC_API_KEY/);
  });
});
