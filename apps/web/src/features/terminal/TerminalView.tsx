import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/api/client.ts';
import { connectPty, type PtySocket, type PtySocketStatus } from '@/api/pty-socket.ts';

export function TerminalView({ ptyId, active }: { ptyId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sockRef = useRef<PtySocket | null>(null);
  const [status, setStatus] = useState<PtySocketStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const sendSize = (): void => {
      try {
        fit.fit();
      } catch {
        return; // hidden or detached host
      }
      sock.send({ t: 'resize', cols: term.cols, rows: term.rows });
    };
    const sock = connectPty(
      ptyId,
      {
        onData: (d) => term.write(d),
        onExit: (code) => setExitCode(code),
        onReset: () => term.reset(),
        onStatus: (s) => {
          setStatus(s);
          if (s === 'open') sendSize();
        },
      },
      { token: getToken() },
    );
    sockRef.current = sock;
    const input = term.onData((d) => sock.send({ t: 'in', d }));
    const observer = new ResizeObserver(() => sendSize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      input.dispose();
      sock.close();
      term.dispose();
      termRef.current = null;
      sockRef.current = null;
    };
  }, [ptyId]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      sockRef.current?.send({ t: 'resize', cols: term.cols, rows: term.rows });
    } catch {
      // not laid out yet; the ResizeObserver will retry
    }
    term.focus();
  }, [active]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full p-1" data-testid={`terminal-${ptyId}`} />
      {exitCode !== undefined ? (
        <p className="absolute right-2 bottom-1 rounded bg-black/70 px-2 text-xs text-white">
          Process exited (code {exitCode ?? '?'})
        </p>
      ) : status !== 'open' ? (
        <p className="absolute right-2 bottom-1 rounded bg-black/70 px-2 text-xs text-white">
          {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </p>
      ) : null}
    </div>
  );
}
