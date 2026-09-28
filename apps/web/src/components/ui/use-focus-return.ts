import { useRef } from 'react';

/**
 * Radix Dialog/Sheet only return focus to their own Trigger. When a dialog is opened from state
 * (a page-header button, a row action, a shortcut), call this with `open` and pass the result to
 * the content's `onCloseAutoFocus` so focus goes back to whatever opened it.
 */
export function useFocusReturn(open: boolean): (e: Event) => void {
  const wasOpen = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  // Recorded during the render that opens the dialog, before Radix moves focus inside it.
  if (open && !wasOpen.current && document.activeElement instanceof HTMLElement)
    returnTo.current = document.activeElement;
  wasOpen.current = open;
  return (e) => {
    const el = returnTo.current;
    if (el?.isConnected && el !== document.body) {
      e.preventDefault();
      el.focus();
    }
  };
}
