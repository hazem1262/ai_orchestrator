import type { LiveEvent } from '@orc/api-contract';
import type { QueryClient } from '@tanstack/react-query';

/** Phase 3 cache effects of live events. Called by useLiveEvents() after its own Phase 2 handling. */
export function applyP3LiveEvent(qc: QueryClient, e: LiveEvent): void {
  switch (e.type) {
    case 'session.updated':
      void qc.invalidateQueries({
        queryKey: ['session', e.session.source, e.session.id],
        predicate: (q) => q.queryKey.length > 3,
      });
      return;
    case 'audit.recorded':
      void qc.invalidateQueries({ queryKey: ['audit'] });
      return;
    default:
      return;
  }
}
