import type { PtyInfo } from '@orc/api-contract';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminals.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { TerminalDock } from './TerminalDock.tsx';

type Handlers = import('../../api/pty-socket.ts').PtySocketHandlers;

const mocks = vi.hoisted(() => ({
  sockets: [] as Array<{ ptyId: string; handlers: Handlers; sent: unknown[]; closed: boolean }>,
  writes: [] as string[],
  terminals: [] as Array<{ type(d: string): void }>,
}));

vi.mock('@/api/pty-socket.ts', () => ({
  connectPty: (ptyId: string, handlers: Handlers) => {
    const s = { ptyId, handlers, sent: [] as unknown[], closed: false };
    mocks.sockets.push(s);
    return {
      send: (m: unknown) => s.sent.push(m),
      close: () => {
        s.closed = true;
      },
    };
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    private handler: ((d: string) => void) | null = null;
    loadAddon = () => undefined;
    open = () => undefined;
    focus = () => undefined;
    dispose = () => undefined;
    reset = () => {
      mocks.writes.push('<reset>');
    };
    write = (d: string | Uint8Array) => {
      mocks.writes.push(typeof d === 'string' ? d : new TextDecoder().decode(d));
    };
    onData = (fn: (d: string) => void) => {
      this.handler = fn;
      mocks.terminals.push(this);
      return { dispose: () => undefined };
    };
    type(d: string): void {
      this.handler?.(d);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = () => undefined;
  },
}));

const pty = (id: string, exitedAt: string | null = null): PtyInfo => ({
  id,
  sessionPk: `claude:${id}`,
  command: 'claude',
  args: ['--resume', id],
  cwd: '/w',
  pid: 1,
  startedAt: 'now',
  exitedAt,
  exitCode: exitedAt ? 0 : null,
  cols: 120,
  rows: 36,
});

describe('TerminalDock', () => {
  beforeEach(() => {
    mocks.sockets.length = 0;
    mocks.writes.length = 0;
    mocks.terminals.length = 0;
    useTerminalStore.setState({ tabs: [], active: null });
  });

  it('renders nothing without tabs', () => {
    const { container } = renderWithProviders(<TerminalDock />);
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows tabs, streams output, forwards input and resizes on open', async () => {
    useTerminalStore.getState().open('p1', 'Session A');
    useTerminalStore.getState().open('p2', 'Session B');
    const api = createFakeApi({ ptyList: vi.fn(async () => [pty('p1'), pty('p2')]) });
    renderWithProviders(<TerminalDock />, { api });

    expect((await screen.findByRole('tab', { name: 'Session B' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(mocks.sockets.map((s) => s.ptyId)).toEqual(['p1', 'p2']);
    const p2 = mocks.sockets[1];
    if (!p2) throw new Error('missing socket');
    act(() => {
      p2.handlers.onStatus?.('open');
      p2.handlers.onReset?.();
      p2.handlers.onData(new TextEncoder().encode('fake-claude --resume p2'));
    });
    expect(p2.sent).toContainEqual({ t: 'resize', cols: 100, rows: 30 });
    expect(mocks.writes).toEqual(['<reset>', 'fake-claude --resume p2']);
    act(() => mocks.terminals[1]?.type('ls\r'));
    expect(p2.sent).toContainEqual({ t: 'in', d: 'ls\r' });

    act(() => p2.handlers.onExit(0));
    expect(screen.getByText('Process exited (code 0)')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Session A' }));
    expect(useTerminalStore.getState().active).toBe('p1');
    await userEvent.click(screen.getByRole('button', { name: 'Close Session A' }));
    expect(useTerminalStore.getState().tabs.map((t) => t.ptyId)).toEqual(['p2']);
    expect(mocks.sockets[0]?.closed).toBe(true);
  });

  it('stops the active process only after confirmation', async () => {
    useTerminalStore.getState().open('p1', 'Session A');
    const api = createFakeApi({ ptyList: vi.fn(async () => [pty('p1')]) });
    renderWithProviders(<TerminalDock />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(api.ptyKill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    await waitFor(() => expect(api.ptyKill).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(useTerminalStore.getState().tabs).toEqual([]));
  });

  it('drops tabs whose PTY no longer exists', async () => {
    useTerminalStore.getState().open('gone', 'Old');
    useTerminalStore.getState().open('p1', 'Session A');
    renderWithProviders(<TerminalDock />, {
      api: createFakeApi({ ptyList: vi.fn(async () => [pty('p1', 'later')]) }),
    });
    await waitFor(() => expect(useTerminalStore.getState().tabs.map((t) => t.ptyId)).toEqual(['p1']));
    expect(await screen.findByRole('tab', { name: 'Session A (exited)' })).toBeTruthy();
  });
});
