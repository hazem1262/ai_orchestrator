import type { ReviewComment } from '../types/index.ts';

export function buildReviewPrompt(comments: ReviewComment[], opts: { branch?: string | null } = {}): string {
  const sorted = [...comments].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
  const where = opts.branch ? ` (branch ${opts.branch})` : '';
  const out = [
    `Review feedback on your changes${where}. Address every comment below, keep the changes minimal, run the relevant tests, then reply with a short summary per comment.`,
    '',
  ];
  sorted.forEach((c, i) => {
    const suffix = c.side === 'old' ? ' (removed line)' : '';
    out.push(`${i + 1}. ${c.file}:${c.line}${suffix}`);
    for (const bodyLine of c.body.trim().split('\n')) out.push(`   ${bodyLine}`);
  });
  return out.join('\n');
}
