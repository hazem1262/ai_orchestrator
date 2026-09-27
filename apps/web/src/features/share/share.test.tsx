import type { LinearIssue } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 as renderWithClient } from '../../test/p3-render.tsx';
import { LinearIssueChip } from '../linear/LinearIssueChip.tsx';
import { todayLocal } from './DailyUpdateButton.tsx';
import { FollowUpDialog } from './FollowUpDialog.tsx';
import { ShareDialog } from './ShareDialog.tsx';

const confirmError = (preview: string) =>
  Object.assign(new Error('confirm to continue'), {
    status: 409,
    code: 'confirmation_required',
    details: { summary: 'Post this comment on SAF-1787 in Linear as you?', preview },
  });

const issue: LinearIssue = {
  id: 'i1',
  identifier: 'SAF-1787',
  title: 'Exclude weekends',
  state: 'In Review',
  assignee: 'Test User',
  url: 'https://linear.app/example/issue/SAF-1787',
  labels: [],
};

describe('share UI', () => {
  afterEach(() => setApiClientForTests(null));

  it('previews, then posts exactly the previewed text to Linear', async () => {
    const linearComment = vi
      .fn()
      .mockRejectedValueOnce(confirmError('**Session recap**\n\nDone.'))
      .mockResolvedValueOnce({ ok: true });
    setApiClientForTests(fakeApi({ linearComment }));
    const onClose = vi.fn();
    renderWithClient(
      <ShareDialog
        title="Recap to Linear"
        target={{ kind: 'linear-comment', identifier: 'SAF-1787' }}
        source={{ kind: 'recap', sessionPk: 'claude:s1' }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Post this comment on SAF-1787 in Linear as you?')).toBeTruthy();
    expect(screen.getByTestId('share-preview').textContent).toBe('**Session recap**\n\nDone.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and post' }));
    await waitFor(() => expect(screen.getByText('Posted.')).toBeTruthy());
    expect(linearComment.mock.calls).toEqual([
      ['SAF-1787', { kind: 'recap', sessionPk: 'claude:s1' }, false],
      ['SAF-1787', { kind: 'text', text: '**Session recap**\n\nDone.' }, true],
    ]);
  });

  it('shows non-confirmation errors', async () => {
    const slackPost = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Slack is not connected'), { code: 'unauthenticated' }));
    setApiClientForTests(fakeApi({ slackPost }));
    renderWithClient(
      <ShareDialog
        title="Daily update"
        target={{ kind: 'slack-post' }}
        source={{ kind: 'daily', projectId: 'wakecap', date: '2026-09-17' }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Slack is not connected');
    expect(slackPost).toHaveBeenCalledWith({
      channel: undefined,
      source: { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' },
      confirm: false,
    });
  });

  it('creates a follow-up ticket after confirmation', async () => {
    const linearFollowUp = vi
      .fn()
      .mockRejectedValueOnce(confirmError('Handle holidays'))
      .mockResolvedValueOnce({
        ...issue,
        identifier: 'SAF-2001',
        url: 'https://linear.app/example/issue/SAF-2001',
      });
    setApiClientForTests(fakeApi({ linearFollowUp }));
    renderWithClient(
      <FollowUpDialog sessionPk="claude:s1" defaultTitle="Handle holidays" onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByRole('link', { name: 'SAF-2001' })).toBeTruthy();
    expect(linearFollowUp.mock.calls[1]?.[0]).toEqual({
      sessionPk: 'claude:s1',
      title: 'Handle holidays',
      description: '',
      teamKey: undefined,
      includeRecap: true,
      confirm: true,
    });
  });

  it('renders the Linear chip only when the issue loads', async () => {
    setApiClientForTests(fakeApi({ linearIssue: async () => issue }));
    renderWithClient(<LinearIssueChip identifier="SAF-1787" />);
    const link = await screen.findByRole('link');
    expect(link.textContent).toBe('SAF-1787 · In Review · Test User');
    expect(link.getAttribute('href')).toBe(issue.url);
  });

  it('formats the local date', () => {
    expect(todayLocal(new Date(2026, 8, 7, 23, 30))).toBe('2026-09-07');
  });
});
