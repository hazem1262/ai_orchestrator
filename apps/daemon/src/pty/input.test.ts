import { tmpdir } from 'node:os';
import { encodePaste as coreEncodePaste, sendText as coreSendText } from '@orc/core';
import { spawn as ptySpawn } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { encodePaste, SUBMIT_DELAY_MS, sendText } from './input.ts';

/**
 * Ruling 1 (controller): the paste encoding itself is @orc/core's contract (contracts
 * §13, validated by spike S2/S8) and is covered by packages/core/src/pty/paste.test.ts.
 * This file only pins that pty/input.ts is a thin re-export (no drift/reimplementation)
 * and covers the PTY-level wrapper: writing into a *live* pty and the ordering/idle
 * behaviour of sendText against real process output.
 */
describe('pty/input re-export', () => {
  it('re-exports the core implementations verbatim, not a reimplementation', () => {
    expect(encodePaste).toBe(coreEncodePaste);
    expect(sendText).toBe(coreSendText);
    expect(SUBMIT_DELAY_MS).toBe(120);
  });
});

describe('sendText against a live pty', () => {
  // Note: a real pty in cooked mode echoes input through the line discipline (which
  // caret-escapes control bytes and rewrites embedded '\n' to '\r\n'), so these tests
  // assert on plain-text arrival and timing rather than exact escape-sequence byte
  // offsets — that encoding contract is @orc/core's, pinned in paste.test.ts.
  it('delivers pasted text into a live pty and only resolves after the submit delay', async () => {
    const proc = ptySpawn('/bin/cat', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
    });
    const chunks: string[] = [];
    proc.onData((d) => chunks.push(d));

    const start = Date.now();
    await sendText((d) => proc.write(d), 'MARKER_TEXT', { submitDelayMs: 40 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);

    await vi.waitFor(() => expect(chunks.join('')).toContain('MARKER_TEXT'));
    proc.kill();
  });

  it('does not block an interleaved write to the same live pty during the submit delay', async () => {
    const proc = ptySpawn('/bin/cat', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
    });
    const chunks: string[] = [];
    proc.onData((d) => chunks.push(d));

    const pending = sendText((d) => proc.write(d), 'FIRSTMARK', { submitDelayMs: 60 });
    proc.write('SIDEMARK');
    await pending;

    await vi.waitFor(() => {
      const out = chunks.join('');
      expect(out).toContain('FIRSTMARK');
      expect(out).toContain('SIDEMARK');
    });
    proc.kill();
  });
});
