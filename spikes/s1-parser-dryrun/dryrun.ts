import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyClaudeRecord, parseJsonLine, readJsonlFrom } from '@orc/core';

const root = join(process.env.CLAUDE_HOME ?? join(homedir(), '.claude'), 'projects');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) return walk(p);
    return p.endsWith('.jsonl') ? [p] : [];
  });
}

const t0 = performance.now();
const files = walk(root);
const counts = new Map<string, number>();
const unknownTypes = new Map<string, number>();
let lines = 0;
let badJson = 0;
let partial = 0;
let bytes = 0;
const sessions = new Set<string>();
const prs = new Set<string>();
let subagentFiles = 0;
let costSum = 0;
const lastCost = new Map<string, number>();

for (const f of files) {
  if (f.includes('/subagents/')) subagentFiles++;
  bytes += statSync(f).size;
  const r = await readJsonlFrom(f, 0);
  if (r.partial) partial++;
  for (const l of r.lines) {
    lines++;
    const v = parseJsonLine(l.text);
    if (v === undefined) {
      badJson++;
      continue;
    }
    const c = classifyClaudeRecord(v);
    const key = c.kind === 'session_meta' ? `session_meta:${c.type}` : c.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (c.kind === 'unknown') unknownTypes.set(String(c.type), (unknownTypes.get(String(c.type)) ?? 0) + 1);
    if (c.kind === 'human_prompt' && !f.includes('/subagents/')) sessions.add(c.rec.sessionId);
    if (c.kind === 'session_meta' && c.type === 'pr-link') prs.add(String(c.rec.prUrl));
    if (c.kind === 'session_meta' && c.type === 'cost-state' && !f.includes('/subagents/')) {
      lastCost.set(f, Number(c.rec.totalCostUSD ?? 0));
    }
  }
}
for (const v of lastCost.values()) costSum += v;

console.log(
  JSON.stringify(
    {
      files: files.length,
      subagentFiles,
      mainSessionsWithPrompts: sessions.size,
      bytes,
      lines,
      badJson,
      partialFiles: partial,
      distinctPrs: prs.size,
      costFromCostState: Math.round(costSum),
      ms: Math.round(performance.now() - t0),
      counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
      unknownTypes: Object.fromEntries(unknownTypes),
    },
    null,
    2,
  ),
);
