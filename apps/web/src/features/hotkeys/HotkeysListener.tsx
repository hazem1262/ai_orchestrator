import { useEffect } from 'react';
import { hotkeys } from './registry.ts';

/** Mounted once in AppShell; the only global keydown listener in the app. */
export function HotkeysListener(): null {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      hotkeys.handle(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return null;
}
