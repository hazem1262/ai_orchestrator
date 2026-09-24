import type { Source } from '@orc/core';
import { useId, useState } from 'react';
import { downloadSessionExport } from '@/api/queries/session-detail.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';

const UNREDACTED_WARNING = 'Export WITHOUT redaction? The ZIP may contain tokens and passwords.';

export function ExportButton({ source, id }: { source: Source; id: string }) {
  const [unredacted, setUnredacted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkboxId = useId();

  const run = async () => {
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

  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
        Export ZIP
      </Button>
      <span className="inline-flex items-center gap-1">
        <Checkbox id={checkboxId} checked={unredacted} onCheckedChange={setUnredacted} />
        <label htmlFor={checkboxId}>Include secrets (unredacted)</label>
      </span>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
