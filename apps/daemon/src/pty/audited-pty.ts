import { type AuditActor, redact } from '@orc/core';
import { type AuditService, audited } from '../services/audit/audit.ts';
import type { PtyManager } from './pty-manager.ts';

const PREVIEW = 500;

/** Removes ANSI escape sequences and control chars; applies backspace/delete; maps CR/LF to newline. */
export function stripControl(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 27) {
      if (s[i + 1] === '[') {
        i += 2;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 127 || code === 8) {
      out = out.slice(0, -1);
      continue;
    }
    if (code === 13 || code === 10) {
      out += '\n';
      continue;
    }
    if (code < 32 && code !== 9) continue;
    out += s[i];
  }
  return out;
}

export function withPtyInputAudit(
  pty: PtyManager,
  audit: AuditService,
  opts: { idleMs?: number; actor?: AuditActor } = {},
): PtyManager & { flushAll(): void } {
  const idleMs = opts.idleMs ?? 1500;
  const actor = opts.actor ?? 'user';
  const buffers = new Map<string, { raw: string; timer: ReturnType<typeof setTimeout> | null }>();
  const targetOf = (id: string) => pty.get(id)?.sessionPk ?? `pty:${id}`;

  const flush = (id: string) => {
    const b = buffers.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    buffers.delete(id);
    const text = stripControl(b.raw).trimEnd();
    audit.record({
      actor,
      actorDetail: null,
      action: 'pty.input',
      target: targetOf(id),
      params: { via: 'keys', ptyId: id, bytes: b.raw.length, text: redact(text).slice(0, PREVIEW) },
      result: 'ok',
      error: null,
    });
  };

  return {
    spawn: (o) => pty.spawn(o),
    write(id, data) {
      try {
        pty.write(id, data);
      } catch (err) {
        flush(id);
        audit.record({
          actor,
          actorDetail: null,
          action: 'pty.input',
          target: targetOf(id),
          params: { via: 'keys', ptyId: id, bytes: data.length },
          result: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const b = buffers.get(id) ?? { raw: '', timer: null };
      b.raw += data;
      buffers.set(id, b);
      if (/[\r\n]/.test(data)) {
        flush(id);
        return;
      }
      if (b.timer) clearTimeout(b.timer);
      b.timer = setTimeout(() => flush(id), idleMs);
      b.timer.unref?.();
    },
    sendText(id, text) {
      return audited(
        audit,
        {
          actor,
          actorDetail: null,
          action: 'pty.input',
          target: targetOf(id),
          params: { via: 'paste', ptyId: id, bytes: text.length, text: redact(text).slice(0, PREVIEW) },
        },
        () => pty.sendText(id, text),
      );
    },
    resize: (id, cols, rows) => pty.resize(id, cols, rows),
    kill(id, signal) {
      flush(id);
      pty.kill(id, signal);
    },
    attach: (id, onData) => pty.attach(id, onData),
    list: () => pty.list(),
    get: (id) => pty.get(id),
    remove(id) {
      flush(id);
      pty.remove(id);
    },
    disposeAll() {
      for (const id of [...buffers.keys()]) flush(id);
      pty.disposeAll();
    },
    flushAll() {
      for (const id of [...buffers.keys()]) flush(id);
    },
  };
}
