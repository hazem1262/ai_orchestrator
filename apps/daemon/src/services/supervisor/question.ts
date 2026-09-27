import { stat } from 'node:fs/promises';
import { classifyClaudeRecord, contentText, parseJsonLine, readJsonlFrom } from '@orc/core';

export interface PendingQuestion {
  /** The assistant's last text (trimmed to 1200 chars) plus the registry's waitingFor line. Used for deny checks. */
  text: string;
  /** The last paragraph only (max 400 chars). Used for allow-list matching. */
  tail: string;
  waitingFor: string | null;
}

const MAX_TEXT = 1200;
const MAX_TAIL = 400;

export function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.at(-1) ?? '';
}

/**
 * Reads only the tail of a transcript and returns the last non-sidechain assistant text.
 * A partial first line (the read starts mid-line) fails to parse and is skipped.
 * When the tail window holds no assistant text, the window doubles until it does or reaches the file start.
 */
export async function lastAssistantTextFromTranscript(
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  let window = Math.max(1, opts.maxBytes ?? 256 * 1024);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  for (;;) {
    const offset = Math.max(0, size - window);
    const text = await lastAssistantTextFrom(path, offset);
    if (text !== null || offset === 0) return text;
    window *= 2;
  }
}

async function lastAssistantTextFrom(path: string, offset: number): Promise<string | null> {
  let lines: Array<{ text: string }>;
  try {
    ({ lines } = await readJsonlFrom(path, offset));
  } catch {
    return null;
  }
  let text: string | null = null;
  for (const line of lines) {
    const value = parseJsonLine(line.text);
    if (value === undefined) continue;
    const c = classifyClaudeRecord(value);
    if (c.kind !== 'assistant' || c.rec.isSidechain === true) continue;
    const t = contentText(c.rec.message?.content).trim();
    if (t) text = t;
  }
  return text;
}

export function buildPendingQuestion(
  lastAssistantText: string | null,
  waitingFor: string | null,
): PendingQuestion | null {
  const body = (lastAssistantText ?? '').trim().slice(-MAX_TEXT);
  const waiting = waitingFor?.trim() ? `[waiting for: ${waitingFor.trim()}]` : '';
  if (!body && !waiting) return null;
  const text = [body, waiting].filter(Boolean).join('\n');
  const tail = (body ? lastParagraph(body) : waiting).slice(-MAX_TAIL);
  return { text, tail: tail || waiting, waitingFor: waitingFor?.trim() ? waitingFor.trim() : null };
}
