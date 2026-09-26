export type BranchType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';

export const DEFAULT_TICKET_REGEX = '\\b([A-Za-z][A-Za-z0-9]{1,9}-\\d+)\\b';

const FILLER = new Set(['the', 'a', 'an', 'for', 'on', 'with', 'of', 'to', 'and', 'in', 'from']);

export function slugify(text: string, maxLen = 30): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !FILLER.has(w));
  let out = '';
  for (const w of words) {
    const next = out === '' ? w : `${out}-${w}`;
    if (next.length > maxLen) {
      if (out === '') out = w.slice(0, maxLen);
      break;
    }
    out = next;
  }
  return out === '' ? 'work' : out;
}

export function branchName(i: { type: BranchType; ticket: string | null; slug: string }): string {
  const slug = slugify(i.slug);
  if (i.ticket === null || i.ticket.trim() === '') return `${i.type}/${slug}`;
  const ticket = i.ticket.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(ticket)) throw new Error(`invalid ticket: ${i.ticket}`);
  return `${i.type}/${ticket}-${slug}`;
}

export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-');
}

export function ticketFromBranch(branch: string, ticketRegex: string | null): string | null {
  const re = new RegExp(ticketRegex ?? DEFAULT_TICKET_REGEX, 'i');
  const m = re.exec(branch);
  if (!m) return null;
  const hit = m[0];
  if (ticketRegex === null && !/-\d+$/.test(hit)) return null;
  return hit.toUpperCase();
}
