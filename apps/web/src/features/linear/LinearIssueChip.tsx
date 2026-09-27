import { useLinearIssue } from '@/api/queries/linear.ts';

/** A link to the Linear issue with its state and assignee; renders nothing until the issue loads. */
export function LinearIssueChip({ identifier }: { identifier: string }) {
  const { data } = useLinearIssue(identifier);
  if (!data) return null;
  const label = [data.identifier, data.state, data.assignee]
    .filter((x): x is string => Boolean(x))
    .join(' · ');
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noreferrer"
      title={data.title}
      className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
    >
      {label}
    </a>
  );
}
