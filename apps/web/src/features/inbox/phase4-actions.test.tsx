import { ApiRequestError } from '@orc/api-contract';
import type { InboxItem } from '@orc/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { PlanApprovalActions } from './PlanApprovalActions.tsx';
import { PrEventActions } from './PrEventActions.tsx';

// Superseded call shape: the daemon composes `dedupeKey` from `{ kind, scope, facet? }` via
// `inboxDedupeKey` (apps/daemon/src/inbox/dedupe-key.ts). The web package cannot import that
// daemon module, so these are the literal strings it produces:
//   { kind: 'plan_approval', scope: { session: 'claude:s1' } }             -> planKey
//   { kind: 'pr_event', scope: { domain: 'pr', id: 'o/r#4' }, facet: 'checks' } -> prChecksKey
const planKey = 'plan_approval:session:claude%3As1';
const prChecksKey = 'pr_event:pr:o%2Fr%234:checks';

const item = (p: Partial<InboxItem>): InboxItem => ({
  id: 'i1',
  kind: 'plan_approval',
  sessionId: 'claude:s1',
  projectId: 'wakecap',
  ticket: 'SAF-1',
  reason: 'Plan awaiting approval',
  dedupeKey: planKey,
  createdAt: 'x',
  updatedAt: 'x',
  state: 'open',
  snoozeUntil: null,
  payload: {},
  ...p,
});

describe('PlanApprovalActions', () => {
  it('shows the plan and approves or rejects with confirmation', async () => {
    const approve = vi.fn(async (_s: string, _i: string, b: { confirm: boolean }) => {
      if (!b.confirm)
        throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Approve the plan' });
      return { ok: true };
    });
    const reject = vi.fn(async (_s: string, _i: string, b: { confirm: boolean }) => {
      if (!b.confirm)
        throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Reject the plan' });
      return { ok: true };
    });
    const api = createFakeApi({
      planApprove: approve as unknown as FakeApi['planApprove'],
      planReject: reject as unknown as FakeApi['planReject'],
    });
    renderWithProviders(<PlanApprovalActions item={item({ payload: { plan: '1. Do X', owned: true } })} />, {
      api,
    });
    expect(screen.getByText('1. Do X')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenLastCalledWith('claude', 's1', { confirm: true }));
    expect((screen.getByRole('button', { name: 'Reject plan' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Feedback for the agent'), { target: { value: 'smaller steps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(reject).toHaveBeenLastCalledWith('claude', 's1', { feedback: 'smaller steps', confirm: true }),
    );
  });

  it('explains when the session is not owned', () => {
    renderWithProviders(<PlanApprovalActions item={item({ payload: { plan: 'p', owned: false } })} />, {
      api: createFakeApi(),
    });
    expect(screen.getByText('Resume this session in the app to answer the plan.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
  });
});

describe('PrEventActions', () => {
  it('links the PR and the review and offers the preset', async () => {
    const launch = vi.fn(async () => ({ ptyId: 'p', sessionId: null }));
    const api = createFakeApi({ sessionsLaunch: launch as unknown as FakeApi['sessionsLaunch'] });
    renderWithProviders(
      <PrEventActions
        item={item({
          kind: 'pr_event',
          dedupeKey: prChecksKey,
          payload: {
            pr: { repo: 'o/r', number: 4, url: 'https://github.com/o/r/pull/4' },
            cwd: '/w',
            event: 'checks_failed',
            presetId: 'preset-fix-ci',
            vars: { prUrl: 'https://github.com/o/r/pull/4', check: 'unit' },
          },
        })}
      />,
      { api },
    );
    expect(screen.getByRole('link', { name: 'Open PR #4' }).getAttribute('href')).toBe(
      'https://github.com/o/r/pull/4',
    );
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/review/claude/s1');
    fireEvent.click(screen.getByRole('button', { name: 'Fix CI' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/w', templateId: 'preset-fix-ci' }),
      ),
    );
  });
});
