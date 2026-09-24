export interface RedactionPattern {
  kind: string;
  /** RegExp source; construct with `new RegExp(source, flags)` per use — this export is stateless. */
  source: string;
  flags: string;
  replace: (match: string, ...groups: string[]) => string;
}

const tag = (kind: string) => `«redacted:${kind}»`;

export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
  {
    kind: 'github',
    source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b',
    flags: 'gi',
    replace: () => tag('github'),
  },
  { kind: 'github', source: '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b', flags: 'gi', replace: () => tag('github') },
  { kind: 'anthropic', source: '\\bsk-ant-[A-Za-z0-9_-]{10,}', flags: 'gi', replace: () => tag('anthropic') },
  { kind: 'openai', source: '\\bsk-[A-Za-z0-9_-]{20,}', flags: 'gi', replace: () => tag('openai') },
  { kind: 'slack', source: '\\bxox[abposr]-[A-Za-z0-9-]{6,}', flags: 'gi', replace: () => tag('slack') },
  { kind: 'aws', source: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', flags: 'gi', replace: () => tag('aws') },
  {
    kind: 'credentials',
    source:
      '\\b((?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|amqps?|https?):\\/\\/)[^\\s:@/]+:[^\\s@/]+@',
    flags: 'gi',
    replace: (_m, scheme) => `${scheme}${tag('credentials')}@`,
  },
  {
    kind: 'bearer',
    source: '(Authorization:\\s*Bearer\\s+)[A-Za-z0-9._~+/=-]+',
    flags: 'gi',
    replace: (_m, prefix) => `${prefix}${tag('bearer')}`,
  },
  {
    kind: 'secret',
    // Negative lookbehind (rather than `\b`) so `PREFIX_TOKEN=`, `GITHUB_TOKEN=`, etc. are
    // caught too — `\b` cannot match between `_` and a following word character.
    source:
      '(?<![A-Za-z0-9_])([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key)\\s*[=:]\\s*)("[^"]*"|\'[^\']*\'|[^\\s&;]+)',
    flags: 'gi',
    replace: (_m, prefix) => `${prefix}${tag('secret')}`,
  },
  {
    kind: 'jwt',
    source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b',
    flags: 'gi',
    replace: () => tag('jwt'),
  },
  {
    kind: 'pem',
    source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    flags: 'gi',
    replace: () => tag('pem'),
  },
  { kind: 'gcp', source: '\\bAIza[0-9A-Za-z_-]{35}\\b', flags: 'gi', replace: () => tag('gcp') },
  { kind: 'npm', source: '\\bnpm_[A-Za-z0-9]{36}\\b', flags: 'gi', replace: () => tag('npm') },
  { kind: 'linear', source: '\\blin_api_[A-Za-z0-9]{20,}\\b', flags: 'gi', replace: () => tag('linear') },
];

export function redact(text: string): string {
  let out = text;
  for (const p of REDACTION_PATTERNS) {
    const re = new RegExp(p.source, p.flags);
    out = out.replace(re, p.replace as (substring: string, ...args: string[]) => string);
  }
  return out;
}

const SENSITIVE_KEY = /(password|passwd|secret|api[_-]?key|authorization|token)$/i;

/** Returns a deep copy with every string redacted; string values under sensitive keys are fully masked. */
export function redactDeep<T>(value: T): T {
  return redactValue(value, null) as T;
}

function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    return key !== null && SENSITIVE_KEY.test(key) ? '«redacted:secret»' : redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, null));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

const PARTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]*/g,
  /\bgithub_pat_[A-Za-z0-9_]*/g,
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]*/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{4,}/g,
];

/**
 * FTS snippets can cut a token short, so the full patterns miss it. Masks known token prefixes.
 * Apply after redact(); the daemon's redactSnippet (http/redact-out.ts) composes both.
 */
export function redactPartialTokens(text: string): string {
  let out = text;
  for (const re of PARTIAL_PATTERNS) out = out.replace(re, '«redacted:partial»');
  return out;
}
