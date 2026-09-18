import { open } from 'node:fs/promises';

export interface TailResult {
  lines: Array<{ offset: number; text: string }>;
  nextOffset: number;
  partial: boolean;
  /** Current size (in bytes) of the file at read time. */
  size: number;
  /**
   * True when the stored `offset` was past the end of the file — the file was replaced or
   * truncated (Claude Code rewrites transcripts on compaction and replaces them on `/clear`).
   * When this is true, `nextOffset` is reset to `0` so the caller re-scans from the start.
   */
  truncated: boolean;
}

const NL = 0x0a;

/**
 * Reads complete newline-terminated lines starting at `offset`.
 * A trailing line without "\n" is not returned; `nextOffset` stays at its start so the next call re-reads it.
 * `maxBytes` is the read chunk size (small values are used in tests).
 */
export async function readJsonlFrom(path: string, offset: number, maxBytes = 1 << 20): Promise<TailResult> {
  if (offset < 0) throw new RangeError('offset must be >= 0');
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (offset > size) {
      return { lines: [], nextOffset: 0, partial: false, size, truncated: true };
    }
    const lines: TailResult['lines'] = [];
    let pos = offset;
    let carry = Buffer.alloc(0);
    let carryStart = offset;
    while (pos < size) {
      const len = Math.min(maxBytes, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead === 0) break;
      const chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NL) {
          const text = chunk.subarray(start, i).toString('utf8').replace(/\r$/, '');
          if (text.length > 0) lines.push({ offset: carryStart + start, text });
          start = i + 1;
        }
      }
      carryStart += start;
      carry = Buffer.from(chunk.subarray(start));
      pos += bytesRead;
    }
    return { lines, nextOffset: carryStart, partial: carry.length > 0, size, truncated: false };
  } finally {
    await fh.close();
  }
}

export function parseJsonLine(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
