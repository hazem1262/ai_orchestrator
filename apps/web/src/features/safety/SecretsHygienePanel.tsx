import type { SecretsFileReport } from '@orc/api-contract';
import { useSecretsReport } from '@/api/queries/safety.ts';
import { Button } from '@/components/ui/button.tsx';

function fileStatus(f: SecretsFileReport): string {
  if (!f.exists) return f.error === 'forbidden' ? 'skipped (never read)' : 'not found';
  if (f.error) return `error: ${f.error}`;
  return f.findings.length === 0 ? 'clean' : `${f.findings.length} findings`;
}

export function SecretsHygienePanel() {
  const q = useSecretsReport();
  const report = q.data;
  const filesWithFindings = report ? report.files.filter((f) => f.findings.length > 0).length : 0;

  return (
    <section aria-label="Secrets hygiene" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Secrets hygiene</h2>
      <p className="text-sm text-muted-foreground">
        Read-only scan of files known to hold plaintext credentials. Values are never shown. Rotate anything
        listed here and move it to the Keychain or an environment variable. Paths are configured in{' '}
        <code className="font-mono text-xs">safety.secretScanPaths</code>.
      </p>
      <div>
        <Button size="sm" variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>
          Rescan
        </Button>
      </div>
      {q.isError && (
        <p role="alert" className="text-sm text-destructive">
          Scan failed.
        </p>
      )}
      {report && (
        <>
          <p data-testid="secrets-summary" className="text-sm">
            {report.totalFindings === 0
              ? 'No secret-like values found.'
              : `${report.totalFindings} findings in ${filesWithFindings} files`}{' '}
            · scanned {new Date(report.scannedAt).toLocaleString()}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">File</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 font-medium">Findings</th>
              </tr>
            </thead>
            <tbody>
              {report.files.map((f) => (
                <tr key={f.path} className="border-t align-top">
                  <td className="py-1 pr-2 font-mono">{f.displayPath}</td>
                  <td className="py-1 pr-2">{fileStatus(f)}</td>
                  <td className="py-1">
                    {f.findings.map((x) => (
                      <div key={`${x.line}-${x.kind}`}>{`line ${x.line} · ${x.kind}`}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
