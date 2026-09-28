import type { Source } from '@orc/core';
import { useState } from 'react';
import { downloadSessionExport } from '@/api/queries/session-detail.ts';

export const UNREDACTED_WARNING = 'Export WITHOUT redaction? The ZIP may contain tokens and passwords.';

/** Downloads the session as a ZIP, redacted unless asked otherwise; an unredacted export asks first. */
export function useSessionExport(source: Source, id: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (unredacted: boolean) => {
    if (unredacted && !window.confirm(UNREDACTED_WARNING)) return;
    setBusy(true);
    setError(null);
    try {
      await downloadSessionExport(source, id, { redact: !unredacted });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}
