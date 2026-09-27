import { useEffect, useState } from 'react';

export const MOBILE_QUERY = '(max-width: 767px)';

/** `matchMedia` is missing in jsdom and some embedded views; without it the layout stays desktop. */
function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(MOBILE_QUERY);
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => mediaQuery()?.matches ?? false);
  useEffect(() => {
    const mql = mediaQuery();
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
