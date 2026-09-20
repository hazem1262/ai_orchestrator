import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';

export function highlight(text: string, needle: string, radius = 40): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || needle.length === 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return [
    start > 0 ? '…' : '',
    text.slice(start, i),
    SNIPPET_OPEN,
    text.slice(i, i + needle.length),
    SNIPPET_CLOSE,
    text.slice(i + needle.length, end),
    end < text.length ? '…' : '',
  ].join('');
}
