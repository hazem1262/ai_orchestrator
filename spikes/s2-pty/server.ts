import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';
// CONTROLLER RULING (task 6): encodePaste/sendText live in @orc/core
// (packages/core/src/pty/paste.ts), not in a local copy here. This spike
// directory is intentionally outside the pnpm workspace (installed with
// `npm install --no-save`), so resolving the "@orc/core" package specifier
// from here is awkward (no workspace symlink, no node_modules/@orc). We
// import the module by relative path into the sibling packages/core
// package instead; tsx transpiles the .ts source directly, no build step
// needed.
import { sendText } from '../../packages/core/src/pty/paste.ts';

const [, , sessionId, cwd] = process.argv;
if (!sessionId || !cwd) {
  console.error('usage: tsx server.ts <claudeSessionId> <originalCwd>');
  process.exit(1);
}

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

const server = createServer((req, res) => {
  if (req.url?.startsWith('/node_modules/')) {
    const path = req.url.split('?')[0] ?? '';
    const ext = path.slice(path.lastIndexOf('.'));
    try {
      const body = readFileSync(new URL(`.${path}`, import.meta.url));
      // Chrome refuses a module script served without a JavaScript MIME type.
      res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(html);
});
const wss = new WebSocketServer({ server, path: '/pty' });

const pty = spawn('claude', ['--resume', sessionId, '--dangerously-skip-permissions'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 36,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
});
console.log('pty spawned, pid', pty.pid);

let scrollback = '';
let totalBytes = 0;
pty.onData((d) => {
  totalBytes += Buffer.byteLength(d, 'utf8');
  scrollback = (scrollback + d).slice(-200_000);
  for (const c of wss.clients) c.send(d);
});
pty.onExit(({ exitCode }) => console.log('pty exited', exitCode));

// Log a byte count periodically so we can confirm output is flowing without
// a browser attached.
setInterval(() => {
  console.log(`[bytes] total pty output so far: ${totalBytes}`);
}, 5000).unref();

wss.on('connection', (ws) => {
  console.log('ws connection accepted, clients now', wss.clients.size);
  ws.send(scrollback);
  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw)) as
      | { t: 'in'; d: string }
      | { t: 'resize'; cols: number; rows: number }
      | { t: 'say'; text: string };
    if (msg.t === 'in') pty.write(msg.d);
    if (msg.t === 'resize') pty.resize(msg.cols, msg.rows);
    if (msg.t === 'say') {
      await sendText((d) => pty.write(d), msg.text);
    }
  });
});

server.listen(4399, '127.0.0.1', () => console.log('open http://127.0.0.1:4399'));
