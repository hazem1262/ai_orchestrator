import type { LiveState, Session } from '@orc/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { liveSessionFixture } from '../../test/factories.ts';
import { fakeApi, type P3FakeApi, renderP3 as renderWithClient } from '../../test/p3-render.tsx';
import { ReadOnlyDiff } from './ReadOnlyDiff.tsx';
import { ReplyComposer } from './ReplyComposer.tsx';

const makeSession = ({
  live,
  ...o
}: Partial<Omit<Session, 'live'>> & { live?: Partial<LiveState> }): Session => liveSessionFixture(o, live);

const owned = (): Session =>
  makeSession({
    id: 's1',
    live: { status: 'waiting', ownership: 'owned', ptyId: 'pty-1', waitingFor: 'Proceed?' },
  });

describe('ReplyComposer', () => {
  afterEach(() => setApiClientForTests(null));

  it('sends a reply and retries once after a step-up', async () => {
    const stepUpError = Object.assign(new Error('confirm with your passkey'), { code: 'step_up_required' });
    const sessionsReply = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValueOnce({ ok: true });
    const webauthnStepUpOptions = vi.fn(async () => ({ challenge: 'c' }));
    const webauthnStepUpVerify = vi.fn(async () => ({ validUntil: 'x' }));
    setApiClientForTests(
      fakeApi({
        sessionsReply,
        webauthnStepUpOptions: webauthnStepUpOptions as unknown as P3FakeApi['webauthnStepUpOptions'],
        webauthnStepUpVerify,
      }),
    );
    const stepUp = vi.fn(async () => {});
    renderWithClient(<ReplyComposer session={owned()} stepUp={stepUp} />);
    fireEvent.change(screen.getByLabelText('Reply to this session'), { target: { value: 'yes, continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sessionsReply).toHaveBeenCalledTimes(2));
    expect(sessionsReply).toHaveBeenLastCalledWith('claude', 's1', 'yes, continue');
    expect(stepUp).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByLabelText('Reply to this session') as HTMLTextAreaElement).value).toBe(''),
    );
  });

  it('explains why sending is off for observed sessions', () => {
    renderWithClient(
      <ReplyComposer session={makeSession({ id: 's2', live: { ownership: 'observed', ptyId: null } })} />,
    );
    expect(screen.getByText(/not running in the app/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});

describe('ReadOnlyDiff', () => {
  it('marks added and removed lines and offers no editing', () => {
    renderWithClient(<ReadOnlyDiff unified={'@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n unchanged'} />);
    expect(screen.getByText('-const a = 1;').className).toContain('text-red');
    expect(screen.getByText('+const a = 2;').className).toContain('text-green');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
