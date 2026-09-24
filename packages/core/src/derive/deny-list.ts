import { redact } from '../redact/redact.ts';
import { firstMatch } from './patterns.ts';

export interface DenyVerdict {
  denied: boolean;
  reason: string | null;
}

/** Shared prod/destructive deny-list (F9). Used by automations (P7), the supervisor (P7) and /api/safety/deny-check. */
export const DEFAULT_DENY_PATTERNS: string[] = [
  '\\b(?:production_server_db|production_server_logs|wecare_production_db)\\b',
  '\\bkubectl\\b[^\\n]*(?:--context[= ]\\S*prod|use-context\\s+\\S*prod)',
  '\\bterraform\\s+(?:apply|destroy)\\b',
  '\\bgit\\s+push\\b[^\\n]*(?:--force(?:-with-lease)?\\b|\\s-f\\b)',
  '\\bgit\\s+reset\\s+--hard\\b',
  '\\bgit\\s+clean\\s+-[a-z]*f',
  '\\brm\\s+(?:-\\S+\\s+)*-[a-z]*(?:r[a-z]*f|f[a-z]*r)',
  '\\brm\\s+(?:-\\S+\\s+)*-[a-z]*r[a-z]*\\s+(?:\\S+\\s+)*?-[a-z]*f',
  '\\bdrop\\s+(?:table|database|schema)\\b',
  '\\btruncate\\s+table\\b',
  '\\bgh\\s+pr\\s+merge\\b',
  '\\bhelm\\s+(?:upgrade|install|uninstall)\\b',
  '\\bdeploy\\b',
];

export function checkDenied(text: string, patterns: string[]): DenyVerdict {
  const hit = firstMatch(text, patterns);
  if (!hit) return { denied: false, reason: null };
  return { denied: true, reason: `matches deny pattern ${hit.pattern}: "${redact(hit.match).slice(0, 80)}"` };
}
