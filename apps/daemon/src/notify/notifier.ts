import type { InboxItem } from '@orc/core';

/**
 * contracts §11 — the notifier contract only. Task 11 adds the implementation below these types;
 * the inbox engine (Task 9) needs nothing but the shape to call `notify`.
 */
export type NotifyChannel = 'macos' | 'webpush' | 'slack_dm';

export interface NotifyChannelImpl {
  id: NotifyChannel;
  send(item: InboxItem, url: string): Promise<void>;
}

export interface Notifier {
  notify(item: InboxItem): Promise<void>;
  register(channel: NotifyChannelImpl): void;
  setAway(away: boolean): void;
  isAway(): boolean;
}
