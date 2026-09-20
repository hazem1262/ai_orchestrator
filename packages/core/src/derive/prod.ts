/** F9 defaults. Matched case-insensitively against Skill names, MCP tool names and Bash commands. */
export const DEFAULT_PROD_PATTERNS: string[] = [
  'production_server_db',
  'production_server_logs',
  'wecare_production_db',
  '\\bkubectl\\b[^\\n]*\\b(?:prod|production)\\b',
  '\\bterraform\\s+apply\\b',
  '\\bprod(?:uction)?-db\\b',
];

export function compileProdPatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // invalid user pattern: skipped (Settings validates on save)
    }
  }
  return out;
}

export function matchesProd(text: string, res: RegExp[]): boolean {
  return res.some((r) => r.test(text));
}
