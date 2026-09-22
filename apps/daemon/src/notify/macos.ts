import type { InboxKind } from '@orc/core';
import nodeNotifier from 'node-notifier';
import type { NotifyChannelImpl } from './notifier.ts';

export interface NodeNotifierLike {
  notify(
    o: { title: string; message: string; open?: string; sound?: boolean; wait?: boolean; group?: string },
    cb?: (err: Error | null) => void,
  ): unknown;
}

export const KIND_TITLE: Record<InboxKind, string> = {
  waiting: 'Waiting for you',
  review: 'Ready for review',
  plan_approval: 'Plan awaiting approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests went red',
  budget: 'Budget',
  automation_result: 'Automation finished',
  supervisor_escalation: 'Supervisor escalation',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

/**
 * The desktop banner. Its text leaves the daemon, so it carries only the kind's fixed title and
 * `item.reason`, which the inbox engine already redacted on the way in. No other item field goes
 * into the body. `group` is `item.dedupeKey`, read as-is so macOS replaces an older banner for the
 * same key; this file never builds a key.
 */
export function createMacosChannel(
  opts: { impl?: NodeNotifierLike; platform?: NodeJS.Platform } = {},
): NotifyChannelImpl {
  const impl = opts.impl ?? (nodeNotifier as unknown as NodeNotifierLike);
  const platform = opts.platform ?? process.platform;
  return {
    id: 'macos',
    send(item, url) {
      if (platform !== 'darwin') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        impl.notify(
          {
            title: `Orchestrator · ${KIND_TITLE[item.kind]}`,
            message: item.reason,
            open: url,
            sound: item.kind === 'waiting',
            wait: false,
            group: item.dedupeKey,
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
  };
}
