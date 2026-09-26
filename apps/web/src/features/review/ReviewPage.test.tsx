import { ApiRequestError } from '@orc/api-contract';
import type { DiffResult, ReviewSummary } from '@orc/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { ReviewPage } from './ReviewPage.tsx';

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 1, Unified: 2 },
  SplitSide: { old: 1, new: 2 },
  DiffView: (p: {
    diffViewMode: number;
    renderWidgetLine: (a: { side: number; lineNumber: number; onClose: () => void }) => ReactNode;
    renderExtendLine: (a: { data: unknown }) => ReactNode;
    extendData: { newFile: Record<string, { data: unknown }> };
  }) => (
    <div data-testid="diffview" data-mode={p.diffViewMode}>
      {p.renderWidgetLine({ side: 2, lineNumber: 1, onClose: () => {} })}
      {Object.values(p.extendData.newFile).map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: test double mirrors the library's line map
        <div key={i}>{p.renderExtendLine({ data: v.data })}</div>
      ))}
    </div>
  ),
}));

const diff: DiffResult = {
  cwd: '/w',
  from: 'base',
  to: 'WORKTREE',
  additions: 2,
  deletions: 1,
  files: [
    {
      path: 'src/a.ts',
      oldPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        { header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
      ],
      patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    },
    {
      path: 'src/new.ts',
      oldPath: null,
      status: 'added',
      additions: 1,
      deletions: 0,
      hunks: [],
      patch: 'diff --git a/src/new.ts b/src/new.ts\n',
    },
  ],
};

const summary = (owned: boolean): ReviewSummary => ({
  sessionPk: 'claude:s1',
  cwd: '/w',
  worktree: null,
  files: [],
  additions: 2,
  deletions: 1,
  lastTest: null,
  recap: null,
  pr: null,
  owned,
  checkpoints: [],
});

let reviewComments: ReturnType<typeof vi.fn>;
let diffRevert: ReturnType<typeof vi.fn>;

function client(owned: boolean): FakeApi {
  reviewComments = vi.fn(async (_s: string, _i: string, body: { deliver: string; confirm: boolean }) => {
    if (body.deliver === 'session' && !body.confirm)
      throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Send 1 review comment(s)' });
    return { sent: body.deliver === 'session', text: 'PROMPT TEXT' };
  });
  diffRevert = vi.fn(async (body: { confirm: boolean }) => {
    if (!body.confirm)
      throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Revert hunk 1 of src/a.ts' });
    return { reverted: 'src/a.ts#0' };
  });
  return createFakeApi({
    reviewGet: async () => summary(owned),
    diffGet: async () => diff,
    checkpointsList: async () => [],
    reviewComments: reviewComments as unknown as FakeApi['reviewComments'],
    diffRevert: diffRevert as unknown as FakeApi['diffRevert'],
    sessionsLaunch: vi.fn(async () => ({ ptyId: 'pty-new', sessionId: null })),
  });
}

beforeEach(() => localStorage.clear());

describe('ReviewPage', () => {
  it('shows the file tree with counts and toggles split/unified', async () => {
    renderWithProviders(<ReviewPage source="claude" id="s1" />, { api: client(true) });
    const tree = await screen.findByRole('navigation', { name: 'Changed files' });
    expect(within(tree).getByText('src/a.ts')).toBeDefined();
    expect(within(tree).getByText('+1 −1')).toBeDefined();
    fireEvent.click(within(tree).getByLabelText('Viewed src/a.ts'));
    expect((within(tree).getByLabelText('Viewed src/a.ts') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('diffview').dataset.mode).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    expect(screen.getByTestId('diffview').dataset.mode).toBe('2');
  });

  it('collects an inline comment and sends it to the owned session after confirmation', async () => {
    renderWithProviders(<ReviewPage source="claude" id="s1" />, { api: client(true) });
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'rename b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(await screen.findByText('src/a.ts:1')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect(await screen.findByText('Send 1 review comment(s)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(reviewComments).toHaveBeenLastCalledWith('claude', 's1', {
        comments: [{ file: 'src/a.ts', line: 1, side: 'new', body: 'rename b' }],
        deliver: 'session',
        confirm: true,
      }),
    );
    await waitFor(() => expect(screen.queryByText('src/a.ts:1')).toBeNull());
  });

  it('offers copy and new-session delivery for observed sessions', async () => {
    const api = client(false);
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(<ReviewPage source="claude" id="s1" />, { api });
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(screen.queryByRole('button', { name: 'Send to agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PROMPT TEXT'));
  });

  it('reverts a hunk only after confirmation', async () => {
    renderWithProviders(<ReviewPage source="claude" id="s1" />, { api: client(true) });
    fireEvent.click(await screen.findByRole('button', { name: 'Revert hunk 1' }));
    expect(await screen.findByText('Revert hunk 1 of src/a.ts')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() =>
      expect(diffRevert).toHaveBeenLastCalledWith({
        cwd: '/w',
        file: 'src/a.ts',
        hunkIndex: 0,
        confirm: true,
      }),
    );
  });
});
