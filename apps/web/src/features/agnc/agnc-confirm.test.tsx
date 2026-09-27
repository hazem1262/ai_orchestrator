import { type AgncStatus, ApiRequestError } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { sessionFixture } from '@/test/factories.ts';
import { fakeApi, renderP3 } from '@/test/p3-render.tsx';
import { AgncConnectCard } from './AgncConnectCard.tsx';
import { AgncSessionPanel } from './AgncSessionPanel.tsx';
import { HandoffToAgncButton } from './HandoffToAgncButton.tsx';

const status = (o: Partial<AgncStatus> = {}): AgncStatus => ({
  enabled: true,
  status: 'ok',
  url: 'https://agnc.wakecap.ai/mcp',
  sessions: 2,
  ...o,
});
const created = {
  id: 'ag-9',
  title: null,
  status: 'queued',
  repoOwner: 'example-org',
  repoName: 'demo',
  branch: null,
  prUrl: null,
  url: null,
  createdAt: null,
  updatedAt: null,
};
const OK = { ok: true as const };
type PromptArgs = [string, { prompt: string; confirm?: boolean }];
type HandoffArgs = [{ source: 'claude' | 'codex'; id: string; confirm?: boolean }];

/** Answers like the daemon: `409 confirmation_required` until the body carries `confirm: true`. */
const confirmFirst = <A extends unknown[], R>(
  result: R,
  summary: string,
  details: Record<string, unknown> = {},
) =>
  vi.fn(async (...args: A): Promise<R> => {
    const body = args[args.length - 1] as { confirm?: boolean };
    if (body.confirm !== true) {
      throw new ApiRequestError(409, 'confirmation_required', 'confirmation required', {
        summary,
        ...details,
      });
    }
    return result;
  });

const remoteSession = () => sessionFixture({ id: 'ag-1', source: 'agnc', availability: 'remote' });
const readers = () => ({
  agncMessages: vi.fn(async () => []),
  agncEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
});

afterEach(() => setApiClientForTests(null));

describe('AGNC 409 confirmation', () => {
  it('shows the redacted prompt and sends it only after Send', async () => {
    const agncPrompt = confirmFirst<PromptArgs, typeof OK>(
      OK,
      'Send this prompt to AGNC session ag-1? It leaves this Mac.',
      { prompt: 'use «redacted:github»' },
    );
    setApiClientForTests(fakeApi({ ...readers(), agncPrompt }));
    renderP3(<AgncSessionPanel session={remoteSession()} />);
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'use ghp_x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to AGNC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to AGNC?' });
    expect(dialog.textContent).toContain('use «redacted:github»');
    expect(agncPrompt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(agncPrompt).toHaveBeenLastCalledWith('ag-1', { prompt: 'use ghp_x', confirm: true }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
  });

  it('cancelling the prompt confirmation sends nothing', async () => {
    const agncPrompt = confirmFirst<PromptArgs, typeof OK>(OK, 'Send this prompt?');
    setApiClientForTests(fakeApi({ ...readers(), agncPrompt }));
    renderP3(<AgncSessionPanel session={remoteSession()} />);
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to AGNC' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(agncPrompt).toHaveBeenCalledTimes(1);
    expect(agncPrompt.mock.calls[0]?.[1]).toEqual({ prompt: 'hello' });
  });

  it('hands off only after the daemon summary is confirmed', async () => {
    const agncHandoff = confirmFirst<HandoffArgs, typeof created>(
      created,
      'Create an AGNC session in example-org/demo from the handoff of "fix"?',
    );
    setApiClientForTests(fakeApi({ agncStatus: vi.fn(async () => status()), agncHandoff }));
    renderP3(<HandoffToAgncButton session={sessionFixture({ id: 's1', source: 'codex' })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hand off to AGNC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand off to AGNC?' });
    expect(dialog.textContent).toContain('example-org/demo');
    fireEvent.click(screen.getByRole('button', { name: 'Create AGNC session' }));
    await waitFor(() =>
      expect(agncHandoff).toHaveBeenLastCalledWith({ source: 'codex', id: 's1', confirm: true }),
    );
    expect(await screen.findByText('created ag-9')).toBeTruthy();
  });

  it('hides the handoff button while AGNC is off and on AGNC sessions', async () => {
    const agncStatus = vi.fn(async () => status({ enabled: false, status: 'disabled' }));
    setApiClientForTests(fakeApi({ agncStatus }));
    const { unmount } = renderP3(<HandoffToAgncButton session={sessionFixture({ id: 's1' })} />);
    await waitFor(() => expect(agncStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Hand off to AGNC' })).toBeNull();
    unmount();
    const enabled = vi.fn(async () => status());
    setApiClientForTests(fakeApi({ agncStatus: enabled }));
    renderP3(<HandoffToAgncButton session={remoteSession()} />);
    await waitFor(() => expect(enabled).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Hand off to AGNC' })).toBeNull();
  });

  it('offers Disconnect when connected and asks first', async () => {
    const agncDisconnect = vi.fn(async () => OK);
    const confirm = vi.fn(() => false);
    setApiClientForTests(fakeApi({ agncStatus: vi.fn(async () => status()), agncDisconnect }));
    renderP3(<AgncConnectCard confirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect AGNC' }));
    expect(confirm).toHaveBeenCalled();
    expect(agncDisconnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Connect AGNC' })).toBeNull();
  });
});
