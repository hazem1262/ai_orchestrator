import type { Project } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { LaunchDialog } from './LaunchDialog.tsx';

// The launch dialog is a modal for keyboard users: opening it moves focus inside, Tab cycles
// within it, Escape closes it, and closing returns focus to the control that opened it.

const projects: Project[] = [
  {
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/Users/test/Wakecap'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 3,
  },
];

function Page() {
  const show = useLaunchStore((s) => s.show);
  return (
    <>
      <button type="button">Behind before</button>
      <button type="button" onClick={() => show()}>
        New session
      </button>
      <a href="/elsewhere">Behind after</a>
      <LaunchDialog />
    </>
  );
}

async function openFromTrigger() {
  const user = userEvent.setup();
  renderWithProviders(<Page />, {
    api: createFakeApi({
      projectsList: vi.fn(async () => projects),
      templatesList: vi.fn(async () => []),
    }),
  });
  const trigger = screen.getByRole('button', { name: 'New session' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'New session' });
  return { user, trigger, dialog };
}

beforeEach(() => {
  useProjectStore.setState({ projectId: 'wakecap' });
  useLaunchStore.setState({ open: false, preset: null });
});

afterEach(() => {
  setApiClientForTests(null);
  useLaunchStore.setState({ open: false, preset: null });
});

describe('LaunchDialog keyboard access', () => {
  it('moves focus into the dialog when it opens', async () => {
    const { dialog } = await openFromTrigger();
    await waitFor(() =>
      expect(dialog, 'focus after opening').toContainElement(document.activeElement as HTMLElement),
    );
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { user, dialog } = await openFromTrigger();
    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(dialog, `focus after Tab #${i + 1}`).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 40; i++) {
      await user.tab({ shift: true });
      expect(dialog, `focus after Shift+Tab #${i + 1}`).toContainElement(
        document.activeElement as HTMLElement,
      );
    }
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { user, trigger } = await openFromTrigger();
    await user.click(screen.getByLabelText('Prompt'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog'), 'dialog after Escape').toBeNull());
    expect(useLaunchStore.getState().open).toBe(false);
    await waitFor(() => expect(document.activeElement, 'focus after Escape').toBe(trigger));
  });

  it('returns focus to the trigger when cancelled', async () => {
    const { user, trigger } = await openFromTrigger();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement, 'focus after Cancel').toBe(trigger));
  });
});
