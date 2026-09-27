import type { Session, Source } from '@orc/core';

const SOURCES: readonly string[] = ['claude', 'codex', 'agnc'];

export function isSource(v: string): v is Source {
  return SOURCES.includes(v);
}

/** A session that runs elsewhere (AGNC): it has no local transcript to resume, fork, share or reply to. */
export function isRemoteSession(session: Pick<Session, 'source'>): boolean {
  return session.source === 'agnc';
}
