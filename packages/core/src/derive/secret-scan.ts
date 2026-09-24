import { REDACTION_PATTERNS } from '../redact/redact.ts';

export interface SecretFinding {
  line: number;
  kind: string;
}

// Non-global copies so `test` keeps no lastIndex state between lines.
const LINE_PATTERNS = REDACTION_PATTERNS.map((p) => ({
  kind: p.kind,
  re: new RegExp(p.source, p.flags.replace('g', '')),
}));

// "SOME_TOKEN": "literal-value" (8+ chars) — env references like "${X}" are fine.
const JSON_SECRET_FIELD = /"[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|PAT)"\s*:\s*"([^"]{8,})"/i;

/** Finds secret-like content. Returns only line numbers (1-based) and kinds — never the values. */
export function scanTextForSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const kinds = new Set<string>();
    for (const p of LINE_PATTERNS) if (p.re.test(line)) kinds.add(p.kind);
    const m = JSON_SECRET_FIELD.exec(line);
    if (m?.[1] && !m[1].startsWith('${') && !m[1].startsWith('«redacted')) kinds.add('json-secret-field');
    for (const kind of kinds) out.push({ line: i + 1, kind });
  });
  return out;
}
