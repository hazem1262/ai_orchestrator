const lineClass = (line: string): string => {
  if (line.startsWith('+')) return 'text-green-700 dark:text-green-400';
  if (line.startsWith('-')) return 'text-red-700 dark:text-red-400';
  if (line.startsWith('@@')) return 'text-sky-700 dark:text-sky-400';
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
