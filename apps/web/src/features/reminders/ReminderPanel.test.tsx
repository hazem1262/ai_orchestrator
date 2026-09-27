import type { Reminder } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { ReminderPanel } from './ReminderPanel.tsx';

const reminder: Reminder = {
  id: 'rem1',
  jobId: 'j1',
  sessionPk: 'claude:s1',
  ticket: 'SAF-1',
  text: 're-check CI',
  dueAt: '2026-09-18T10:20:00.000Z',
  sendToSession: true,
  state: 'pending',
  createdAt: 't',
  firedAt: null,
};

describe('ReminderPanel', () => {
  it('creates a reminder with minutes and the send-to-session option', async () => {
    const remindersCreate = vi.fn(async () => reminder);
    setApiClientForTests(fakeApi({ remindersList: vi.fn(async () => []), remindersCreate }));
    const user = userEvent.setup();
    renderP3(<ReminderPanel sessionPk="claude:s1" ticket="SAF-1" owned />);
    await user.type(await screen.findByLabelText('Reminder'), 're-check CI');
    await user.clear(screen.getByLabelText('In minutes'));
    await user.type(screen.getByLabelText('In minutes'), '20');
    await user.click(screen.getByLabelText('Also send it to the session'));
    await user.click(screen.getByRole('button', { name: 'Add reminder' }));
    await waitFor(() =>
      expect(remindersCreate).toHaveBeenCalledWith({
        sessionPk: 'claude:s1',
        ticket: 'SAF-1',
        text: 're-check CI',
        inMinutes: 20,
        sendToSession: true,
      }),
    );
  });

  it('lists pending reminders, cancels one, and disables sending for observed sessions', async () => {
    const remindersCancel = vi.fn(async () => ({ ...reminder, state: 'cancelled' as const }));
    setApiClientForTests(
      fakeApi({
        remindersList: vi.fn(async () => [reminder]),
        remindersCancel,
        remindersCreate: vi.fn(async () => reminder),
      }),
    );
    const user = userEvent.setup();
    renderP3(<ReminderPanel sessionPk="claude:s1" ticket={null} owned={false} />);
    expect(await screen.findByText('re-check CI')).toBeTruthy();
    expect(screen.getByLabelText('Also send it to the session')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel reminder re-check CI' }));
    expect(remindersCancel).toHaveBeenCalledWith('rem1');
  });
});
