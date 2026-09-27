import { type InboxItem, redact } from '@orc/core';
import { KIND_TITLE } from './macos.ts';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  itemId: string;
}

const MAX_BODY = 180;

/**
 * The only item text a push carries is the project, the ticket and `item.reason`, redacted as one
 * string before it is cut to length so a secret split by the cut is still caught.
 */
export function pushPayload(item: InboxItem, url: string): PushPayload {
  const project = item.projectId ? `[${item.projectId}] ` : '';
  const ticket = item.ticket ? `${item.ticket} · ` : '';
  return {
    title: KIND_TITLE[item.kind],
    body: redact(`${project}${ticket}${item.reason}`).slice(0, MAX_BODY),
    url,
    tag: item.dedupeKey,
    itemId: item.id,
  };
}

/** Notification URLs are built for 127.0.0.1 (P2); a phone needs the tailnet origin instead. */
export function remoteUrl(localUrl: string, origin: string | null): string {
  if (!origin) return localUrl;
  const u = new URL(localUrl);
  return `${origin.replace(/\/$/, '')}${u.pathname}${u.search}`;
}
