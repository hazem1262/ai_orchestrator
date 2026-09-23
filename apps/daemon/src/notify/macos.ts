import type { InboxKind } from '@orc/core';
import nodeNotifier from 'node-notifier';
import type { NotifyChannelImpl } from './notifier.ts';

export interface NodeNotifierLike {
  notify(
    o: { title: string; message: string; open?: string; sound?: boolean; wait?: boolean; group?: string },
    cb?: (err: unknown, data?: unknown) => void,
  ): unknown;
}

/**
 * True for the error node-notifier raises out of its own helper's stdout rather than out of the
 * delivery. `lib/utils.js#fileCommandJson` runs `JSON.parse` over the whole of terminal-notifier's
 * stdout and passes the SyntaxError to the callback; terminal-notifier writes that stdout only
 * after the banner has been delivered, so the throw describes an unreadable activation record and
 * never an undelivered banner. Anything else — a spawn failure, a missing helper, a stderr line —
 * arrives as some other error and still fails the send.
 */
function isHelperOutputParseError(err: unknown): boolean {
  return err instanceof SyntaxError || (err instanceof Error && err.name === 'SyntaxError');
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
  opts: {
    impl?: NodeNotifierLike;
    platform?: NodeJS.Platform;
    log?: { warn(o: object, msg?: string): void };
  } = {},
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
          (err, data) => {
            if (!err) return resolve();
            if (!isHelperOutputParseError(err)) return reject(err);
            opts.log?.warn(
              { err: String(err), channel: 'macos', kind: item.kind, helperOutput: String(data ?? '') },
              'node-notifier could not parse its helper output; the banner was delivered',
            );
            resolve();
          },
        );
      });
    },
  };
}
