export interface RedactionPattern {
  kind: string;
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const tag = (kind: string) => `«redacted:${kind}»`;

export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
  { kind: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: () => tag('github') },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => tag('github') },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: () => tag('anthropic') },
  { kind: 'openai', re: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: () => tag('openai') },
  { kind: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{6,}/g, replace: () => tag('slack') },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => tag('aws') },
  {
    kind: 'credentials',
    re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/)[^\s:@/]+:[^\s@/]+@/g,
    replace: (_m, scheme) => `${scheme}${tag('credentials')}@`,
  },
  {
    kind: 'bearer',
    re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: (_m, prefix) => `${prefix}${tag('bearer')}`,
  },
  {
    kind: 'secret',
    re: /\b((?:[A-Z_]*PASSWORD|passwd|pwd|password|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;]+)/gi,
    replace: (_m, prefix) => `${prefix}${tag('secret')}`,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const p of REDACTION_PATTERNS) {
    out = out.replace(p.re, p.replace as (substring: string, ...args: string[]) => string);
  }
  return out;
}
