import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { GitDialog } from './GitDialog.tsx';

// The shared git dialog frame is a modal for keyboard users: opening it moves focus inside, Tab
// cycles within it, Escape closes it, and closing returns focus to the control that opened it.

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Behind before</button>
      <button type="button" onClick={() => setOpen(true)}>
        Revert
      </button>
      <a href="/elsewhere">Behind after</a>
      {open ? (
        <GitDialog
          title="Revert commit"
          description="Creates a revert commit."
          onClose={() => setOpen(false)}
        >
          <label>
            Message
            <input />
          </label>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="button">Confirm</button>
        </GitDialog>
      ) : null}
    </>
  );
}

async function openFromTrigger() {
  const user = userEvent.setup();
  render(<Page />);
  const trigger = screen.getByRole('button', { name: 'Revert' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Revert commit' });
  return { user, trigger, dialog };
}

describe('GitDialog keyboard access', () => {
  it('moves focus into the dialog when it opens', async () => {
    const { dialog } = await openFromTrigger();
    await waitFor(() =>
      expect(dialog, 'focus after opening').toContainElement(document.activeElement as HTMLElement),
    );
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { user, dialog } = await openFromTrigger();
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog, `focus after Tab #${i + 1}`).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog, `focus after Shift+Tab #${i + 1}`).toContainElement(
        document.activeElement as HTMLElement,
      );
    }
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { user, trigger } = await openFromTrigger();
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog'), 'dialog after Escape').toBeNull());
    await waitFor(() => expect(document.activeElement, 'focus after Escape').toBe(trigger));
  });

  it('returns focus to the trigger when cancelled', async () => {
    const { user, trigger } = await openFromTrigger();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement, 'focus after Cancel').toBe(trigger));
  });
});
