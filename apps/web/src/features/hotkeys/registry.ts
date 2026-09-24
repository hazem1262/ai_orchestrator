import { useEffect } from 'react';

export interface HotkeyBinding {
  id: string;
  keys: string;
  description: string;
  group: 'navigation' | 'actions' | 'inbox' | 'session';
  handler: () => void;
  allowInInputs?: boolean;
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

export interface HotkeyRegistry {
  register(b: HotkeyBinding): () => void;
  handle(e: KeyLike): boolean;
  list(): HotkeyBinding[];
  reset(): void;
}

const SEQUENCE_TIMEOUT_MS = 1000;
const MODIFIER_KEYS = new Set(['shift', 'meta', 'control', 'alt', 'capslock']);

function normalize(e: KeyLike): string {
  const k = e.key.toLowerCase();
  return `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${k}`;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  return target.closest('.xterm') !== null;
}

export function createHotkeyRegistry(now: () => number = Date.now): HotkeyRegistry {
  let stack: HotkeyBinding[] = [];
  let pending: { key: string; at: number } | null = null;

  return {
    register(b) {
      stack.push(b);
      return () => {
        stack = stack.filter((x) => x !== b);
      };
    },
    list() {
      const seen = new Set<string>();
      const out: HotkeyBinding[] = [];
      for (const b of [...stack].reverse()) {
        if (seen.has(b.keys)) continue;
        seen.add(b.keys);
        out.push(b);
      }
      return out.reverse();
    },
    reset() {
      stack = [];
      pending = null;
    },
    handle(e) {
      if (MODIFIER_KEYS.has(e.key.toLowerCase())) return false;
      const key = normalize(e);
      const editable = isEditable(e.target);
      const t = now();
      const combos: string[] = [];
      if (pending && t - pending.at <= SEQUENCE_TIMEOUT_MS) combos.push(`${pending.key} ${key}`);
      combos.push(key);
      for (const combo of combos) {
        const b = stack.findLast((x) => x.keys === combo && (!editable || x.allowInInputs === true));
        if (b) {
          pending = null;
          e.preventDefault();
          b.handler();
          return true;
        }
      }
      const isPrefix = !editable && stack.some((x) => x.keys.startsWith(`${key} `));
      pending = isPrefix ? { key, at: t } : null;
      if (isPrefix) e.preventDefault();
      return isPrefix;
    },
  };
}

export const hotkeys = createHotkeyRegistry();

export function useHotkeys(bindings: HotkeyBinding[], deps: unknown[]): void {
  useEffect(
    () => {
      const offs = bindings.map((b) => hotkeys.register(b));
      return () => {
        for (const off of offs) off();
      };
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the handler dependencies explicitly
    deps,
  );
}

const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export function formatKeys(keys: string, mac: boolean = isMacPlatform()): string {
  return keys
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((p) =>
          p === 'mod' ? (mac ? '⌘' : 'Ctrl+') : p === 'alt' ? (mac ? '⌥' : 'Alt+') : p.toUpperCase(),
        )
        .join(''),
    )
    .join(' then ');
}
