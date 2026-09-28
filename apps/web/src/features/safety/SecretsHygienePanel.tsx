import type { SecretsFileReport } from '@orc/api-contract';
import { useSecretsReport } from '@/api/queries/safety.ts';
import { Button } from '@/components/ui/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { SettingsCard } from '@/features/settings/SettingsCard.tsx';

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
    <SettingsCard
      label="Secrets hygiene"
      title="Secrets hygiene"
      description={
        <>
          Read-only scan of files known to hold plaintext credentials. Values are never shown. Rotate anything
          listed here and move it to the Keychain or an environment variable. Paths are configured in{' '}
          <code className="font-mono text-xs">safety.secretScanPaths</code>.
        </>
      }
    >
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
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground">File</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground">Findings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.files.map((f) => (
                <TableRow key={f.path} className="align-top">
                  <TableCell className="break-all whitespace-normal font-mono">{f.displayPath}</TableCell>
                  <TableCell>{fileStatus(f)}</TableCell>
                  <TableCell>
                    {f.findings.map((x) => (
                      <div key={`${x.line}-${x.kind}`}>{`line ${x.line} · ${x.kind}`}</div>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SettingsCard>
  );
}
