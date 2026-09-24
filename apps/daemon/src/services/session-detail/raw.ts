import { open } from 'node:fs/promises';
import type { RawLine, RawPage } from '@orc/api-contract';
import { redact } from '@orc/core';

function toLine(offset: number, text: string, max: number, partial: boolean): RawLine {
  const red = redact(text);
  return { offset, text: red.length > max ? red.slice(0, max) : red, truncated: red.length > max, partial };
}

/** Read-only page of JSONL lines starting at a byte offset. Lines are redacted and clipped. */
export async function readJsonlPage(
  path: string,
  offset: number,
  limit: number,
  opts: { maxLineChars?: number; windowBytes?: number } = {},
): Promise<RawPage> {
  const maxLineChars = opts.maxLineChars ?? 20_000;
  let windowBytes = opts.windowBytes ?? 1 << 20;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const items: RawLine[] = [];
    let pos = Math.min(offset, size);
    while (items.length < limit && pos < size) {
      const len = Math.min(windowBytes, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length && items.length < limit; i++) {
        if (chunk[i] !== 0x0a) continue;
        const text = chunk.subarray(start, i).toString('utf8').replace(/\r$/, '');
        if (text.length > 0) items.push(toLine(pos + start, text, maxLineChars, false));
        start = i + 1;
      }
      if (start === 0) {
        if (pos + bytesRead >= size) {
          const text = chunk.toString('utf8');
          if (text.length > 0) items.push(toLine(pos, text, maxLineChars, true));
          pos = size;
          break;
        }
        windowBytes *= 2;
        continue;
      }
      pos += start;
    }
    return { path, items, nextOffset: pos < size ? pos : null };
  } finally {
    await fh.close();
  }
}
