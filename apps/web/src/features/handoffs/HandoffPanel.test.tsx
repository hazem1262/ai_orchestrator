import type { Handoff } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { HandoffPanel } from './HandoffPanel.tsx';

const handoff: Handoff = {
  id: 'h1',
  sessionId: 'claude:s1',
  status: 'ready_for_review',
  summary: 'Weekend rule done.',
  evidence: ['PR: https://x/1'],
  files: ['/a.ts'],
  nextSteps: ['Merge the PR'],
  blockers: [],
  links: ['https://x/1'],
  createdAt: '2026-09-18T09:00:00.000Z',
};

describe('HandoffPanel', () => {
  it('generates, renders and resumes fresh after a confirmation', async () => {
    const handoffsGenerate = vi.fn(async () => handoff);
    const handoffsResumeFresh = vi.fn(async () => ({ ptyId: 'pty-3' }));
    setApiClientForTests(
      fakeApi({
        handoffsLatest: vi.fn(async () => ({
          handoff,
          markdown: '# Handoff — ready_for_review\n\n## Next steps\n1. Merge the PR',
        })),
        handoffsGenerate,
        handoffsResumeFresh,
      }),
    );
    const user = userEvent.setup();
    renderP3(<HandoffPanel source="claude" id="s1" />);
    expect(await screen.findByText(/Merge the PR/)).toBeTruthy();
    expect(screen.getByText('ready_for_review')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(handoffsGenerate).toHaveBeenCalledWith('claude', 's1');
    await user.click(screen.getByRole('button', { name: 'Resume fresh with handoff…' }));
    expect(handoffsResumeFresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm — start a new session' }));
    await waitFor(() => expect(handoffsResumeFresh).toHaveBeenCalledWith('h1'));
    expect(await screen.findByText(/Started a new session/)).toBeTruthy();
  });

  it('offers to create the first handoff', async () => {
    setApiClientForTests(
      fakeApi({ handoffsLatest: vi.fn(async () => null), handoffsGenerate: vi.fn(async () => handoff) }),
    );
    renderP3(<HandoffPanel source="claude" id="s1" />);
    expect(await screen.findByRole('button', { name: 'Create handoff' })).toBeTruthy();
  });
});
