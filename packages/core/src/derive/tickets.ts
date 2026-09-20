export const DEFAULT_TICKET_REGEX = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';

export function compileTicketRegex(source: string | null): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'g');
  } catch {
    return null;
  }
}

export function extractTickets(text: string, re: RegExp | null): string[] {
  if (!re || !text) return [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    const t = String(m[0]).toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
