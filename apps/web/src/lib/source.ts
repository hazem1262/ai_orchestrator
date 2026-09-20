import type { Source } from '@orc/core';

const SOURCES: readonly string[] = ['claude', 'codex', 'agnc'];

export function isSource(v: string): v is Source {
  return SOURCES.includes(v);
}
