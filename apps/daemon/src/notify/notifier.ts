import type { OrcConfig } from '@orc/api-contract';
import type { InboxItem, InboxKind } from '@orc/core';

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

export interface NotifyPref {
  enabled: boolean;
  channels: NotifyChannel[];
}

const ON: NotifyPref = { enabled: true, channels: ['macos'] };
export const DEFAULT_NOTIFY_PREFS: Partial<Record<InboxKind, NotifyPref>> = {
  waiting: ON,
  review: ON,
  error: ON,
  tests_red: ON,
  plan_approval: ON,
  blocked: ON,
};

export function prefFor(cfg: OrcConfig, kind: InboxKind): NotifyPref {
  const pref = cfg.notifications[kind] ?? DEFAULT_NOTIFY_PREFS[kind];
  return pref ? { enabled: pref.enabled, channels: [...pref.channels] } : { enabled: false, channels: [] };
}

export function notificationUrl(item: InboxItem, port: number): string {
  const base = `http://127.0.0.1:${port}`;
  const source = typeof item.payload.source === 'string' ? item.payload.source : null;
  const id = typeof item.payload.id === 'string' ? item.payload.id : item.sessionId;
  return source && id
    ? `${base}/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
    : `${base}/inbox`;
}

const MAX_DEBOUNCE_ENTRIES = 2000;

/**
 * Sends each inbox item to the channels its kind is configured for. The debounce map is keyed by
 * `item.dedupeKey`, read as-is from the engine's composed key — this file never builds a key.
 * A key is claimed synchronously, before the first channel send is awaited, so a same-key notify
 * that arrives while a send is still in flight is suppressed. The claim is released when no
 * channel accepted the notification, so an away-skipped or failed attempt never silences the next
 * one.
 */
export function createNotifier(opts: {
  config: () => OrcConfig;
  log?: { warn(o: object, msg?: string): void };
  debounceMs?: number;
  now?: () => number;
}): Notifier {
  const channels = new Map<NotifyChannel, NotifyChannelImpl>();
  const lastSent = new Map<string, number>();
  const debounceMs = opts.debounceMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let away = false;

  return {
    register(ch) {
      channels.set(ch.id, ch);
    },
    setAway(v) {
      away = v;
    },
    isAway: () => away,
    async notify(item) {
      const cfg = opts.config();
      const pref = prefFor(cfg, item.kind);
      if (!pref.enabled || pref.channels.length === 0) return;
      const t = now();
      const prev = lastSent.get(item.dedupeKey);
      if (prev !== undefined && t - prev < debounceMs) return;
      const url = notificationUrl(item, cfg.port);
      lastSent.delete(item.dedupeKey);
      lastSent.set(item.dedupeKey, t);
      if (lastSent.size > MAX_DEBOUNCE_ENTRIES) {
        const oldest = lastSent.keys().next();
        if (!oldest.done) lastSent.delete(oldest.value);
      }
      let sent = false;
      for (const id of pref.channels) {
        if (away && id === 'macos') continue;
        const ch = channels.get(id);
        if (!ch) continue;
        try {
          await ch.send(item, url);
          sent = true;
        } catch (err) {
          opts.log?.warn({ err: String(err), channel: id, kind: item.kind }, 'notification channel failed');
        }
      }
      // Release only our own claim: a later notify may have re-claimed the key once the window passed.
      if (!sent && lastSent.get(item.dedupeKey) === t) lastSent.delete(item.dedupeKey);
    },
  };
}
