import type { SlackBridge } from '../services/remote/slack-bridge.ts';
import type { NotifyChannelImpl } from './notifier.ts';

/** Slack DM to myself (as me). The bridge turns the message into a thread I can reply in. */
export function createSlackDmChannel(bridge: Pick<SlackBridge, 'ensureThread'>): NotifyChannelImpl {
  return { id: 'slack_dm', send: (item, url) => bridge.ensureThread(item, url) };
}
