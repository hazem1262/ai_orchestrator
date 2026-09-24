import { redact } from '../redact/redact.ts';
import type { TimelineEvent } from '../types/index.ts';
import { compilePattern } from './patterns.ts';
import { DEFAULT_PROD_PATTERNS } from './prod.ts';

export const DEFAULT_PROD_SKILLS: readonly string[] = [
  'production_server_db',
  'production_server_logs',
  'wecare_production_db',
];

export interface ProdTouch {
  seq: number;
  ts: string;
  agentId: string | null;
  kind: 'skill' | 'command';
  tool: string;
  detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shell command text of a Bash (Claude) or shell (Codex) tool call. */
export function commandOf(e: TimelineEvent): string | null {
  if (e.kind !== 'tool_call' || !isObj(e.input)) return null;
  const cmd = e.input.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === 'string')) return cmd.join(' ');
  return null;
}

export function detectProdTouches(
  events: readonly TimelineEvent[],
  opts: { prodSkills?: readonly string[]; prodPatterns?: readonly string[] } = {},
): ProdTouch[] {
  const skills = new Set(opts.prodSkills ?? DEFAULT_PROD_SKILLS);
  const patterns = [...DEFAULT_PROD_PATTERNS, ...(opts.prodPatterns ?? [])];
  const out: ProdTouch[] = [];
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;
    const base = { seq: e.seq, ts: e.ts, agentId: e.agentId, tool: e.tool };
    if (
      e.tool === 'Skill' &&
      isObj(e.input) &&
      typeof e.input.skill === 'string' &&
      skills.has(e.input.skill)
    ) {
      out.push({ ...base, kind: 'skill', detail: e.input.skill });
      continue;
    }
    const cmd = commandOf(e);
    if (cmd !== null && patterns.some((p) => compilePattern(p).test(cmd))) {
      out.push({ ...base, kind: 'command', detail: redact(cmd).slice(0, 160) });
    }
  }
  return out;
}
