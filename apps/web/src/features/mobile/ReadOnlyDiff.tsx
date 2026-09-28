const lineClass = (line: string): string => {
  if (line.startsWith('+')) return 'text-success';
  if (line.startsWith('-')) return 'text-destructive';
  if (line.startsWith('@@')) return 'text-info';
  return 'opacity-80';
};

/** Read-only diff for phones: no inline comments, no revert, no staging. */
export function ReadOnlyDiff({ unified }: { unified: string }) {
  return (
    <pre className="overflow-x-auto rounded border p-2 text-xs leading-5">
      {unified.split('\n').map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
        <div key={i} className={lineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  );
}
