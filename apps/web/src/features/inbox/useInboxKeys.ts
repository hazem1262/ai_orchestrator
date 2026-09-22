import { useEffect, useState } from 'react';
import { useLaunchStore } from '@/stores/launch.ts';

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

/**
 * The window-level triage keys (docs/02 F8/F15). The listener reads the launch store directly
 * rather than subscribing, so opening the dialog suppresses the keys without a re-render.
 */
export function useInboxKeys(o: {
  count: number;
  onDone(i: number): void;
  onSnooze(i: number): void;
  onOpen(i: number): void;
}): { selected: number; setSelected(i: number): void } {
  const [selected, setSelected] = useState(0);
  const { count, onDone, onSnooze, onOpen } = o;

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, count - 1)));
  }, [count]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || count === 0) return;
      if (isTypingTarget(e.target) || useLaunchStore.getState().open) return;
      switch (e.key) {
        case 'j':
          setSelected((s) => Math.min(count - 1, s + 1));
          break;
        case 'k':
          setSelected((s) => Math.max(0, s - 1));
          break;
        case 'e':
          onDone(selected);
          break;
        case 's':
          onSnooze(selected);
          break;
        case 'Enter':
          onOpen(selected);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count, selected, onDone, onSnooze, onOpen]);

  return { selected, setSelected };
}
