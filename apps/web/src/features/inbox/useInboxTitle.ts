import { useEffect } from 'react';

export function inboxTitle(count: number): string {
  return count > 0 ? `(${count}) Orchestrator` : 'Orchestrator';
}

export function useInboxTitle(count: number): void {
  useEffect(() => {
    document.title = inboxTitle(count);
  }, [count]);
}
