import type { Source } from '@orc/core';

const SOURCES: readonly Source[] = ['claude', 'codex', 'agnc'];

export const sessionPk = (source: Source, id: string): string => `${source}:${id}`;

export function splitPk(pk: string): { source: Source; id: string } {
  const i = pk.indexOf(':');
  const source = pk.slice(0, i) as Source;
  if (i <= 0 || !SOURCES.includes(source)) throw new Error(`invalid session pk: ${pk}`);
  return { source, id: pk.slice(i + 1) };
}
