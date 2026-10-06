import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/api/client.ts';
import { connectPty, type PtySocket, type PtySocketStatus } from '@/api/pty-socket.ts';
import { DROP_PATHS_EVENT, type DropPathsDetail, dropText } from './drop-paths.ts';

const GEIST_MONO = '"Geist Mono Variable"';
const FALLBACK_FONT = 'Menlo, Monaco, monospace';
const TERMINAL_FONT = `${GEIST_MONO}, ${FALLBACK_FONT}`;

export function TerminalView({ ptyId, active }: { ptyId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sockRef = useRef<PtySocket | null>(null);
  const wasActiveRef = useRef<boolean | null>(null);
  const [status, setStatus] = useState<PtySocketStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fontReady = document.fonts?.check(`12px ${GEIST_MONO}`) === true;
    const term = new Terminal({
      fontFamily: fontReady ? TERMINAL_FONT : FALLBACK_FONT,
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
    // xterm measures glyphs when the font option is set, so switch to Geist Mono once it has loaded.
    let disposed = false;
    if (!fontReady) {
      void document.fonts?.load(`12px ${GEIST_MONO}`).then(() => {
        if (disposed) return;
        term.options.fontFamily = TERMINAL_FONT;
        sendSize();
      });
    }
    const observer = new ResizeObserver(() => sendSize());
    observer.observe(host);
    // The desktop app reports dropped files with their absolute paths; a browser never exposes them.
    const onDropPaths = (event: Event): void => {
      const { paths, x, y } = (event as CustomEvent<DropPathsDetail>).detail;
      const target = document.elementFromPoint(x, y);
      if (!target || !host.contains(target)) return;
      const text = dropText(paths);
      if (!text) return;
      sock.send({ t: 'in', d: text });
      term.focus();
    };
    window.addEventListener(DROP_PATHS_EVENT, onDropPaths);
    return () => {
      disposed = true;
      window.removeEventListener(DROP_PATHS_EVENT, onDropPaths);
      observer.disconnect();
      input.dispose();
      sock.close();
      term.dispose();
      termRef.current = null;
      sockRef.current = null;
    };
  }, [ptyId]);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
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
    // Only a switch to this tab takes the keyboard. A tab that is active on its first render was
    // opened for the user by a launch or a resume, and stealing focus there would send the next
    // keystrokes — inbox triage keys, board shortcuts — into a live agent's stdin.
    if (wasActive === false) term.focus();
  }, [active]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full p-1" data-testid={`terminal-${ptyId}`} />
      {exitCode !== undefined ? (
        <p className="absolute right-2 bottom-1 rounded bg-terminal/70 px-2 text-xs text-terminal-foreground">
          Process exited (code {exitCode ?? '?'})
        </p>
      ) : status !== 'open' ? (
        <p className="absolute right-2 bottom-1 rounded bg-terminal/70 px-2 text-xs text-terminal-foreground">
          {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </p>
      ) : null}
    </div>
  );
}
