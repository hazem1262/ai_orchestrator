import { useEffect, useState } from 'react';
import { useHotkeys } from '@/features/hotkeys/registry.ts';
import { useLaunchStore } from '@/stores/launch.ts';

/**
 * The inbox triage keys (docs/02 F8/F15), registered on the shared hotkey registry. The registry
 * skips typing targets and modified keys; the handlers read the launch store directly rather than
 * subscribing, so opening the dialog suppresses the keys without a re-render.
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

  const guard = (fn: () => void) => () => {
    if (count === 0 || useLaunchStore.getState().open) return;
    fn();
  };

  useHotkeys(
    [
      {
        id: 'inbox-next',
        keys: 'j',
        description: 'Next item',
        group: 'inbox',
        handler: guard(() => setSelected((s) => Math.min(count - 1, s + 1))),
      },
      {
        id: 'inbox-prev',
        keys: 'k',
        description: 'Previous item',
        group: 'inbox',
        handler: guard(() => setSelected((s) => Math.max(0, s - 1))),
      },
      {
        id: 'inbox-done',
        keys: 'e',
        description: 'Mark done',
        group: 'inbox',
        handler: guard(() => onDone(selected)),
      },
      {
        id: 'inbox-snooze',
        keys: 's',
        description: 'Snooze',
        group: 'inbox',
        handler: guard(() => onSnooze(selected)),
      },
      {
        id: 'inbox-open',
        keys: 'enter',
        description: 'Open item',
        group: 'inbox',
        handler: guard(() => onOpen(selected)),
      },
    ],
    [count, selected, onDone, onSnooze, onOpen],
  );

  return { selected, setSelected };
}
