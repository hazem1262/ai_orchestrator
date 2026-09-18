import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyClaudeRecord, parseJsonLine, readJsonlFrom } from '@orc/core';

const root = join(homedir(), '.claude', 'projects');
const since = Date.now() - 7 * 24 * 3600_000;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const s = statSync(p);
    return s.isDirectory() ? walk(p) : p.endsWith('.jsonl') && s.mtimeMs > since ? [p] : [];
  });

type U = { ts: number; tokens: number; model: string };
const seen = new Set<string>();
const usages: U[] = [];
for (const f of walk(root)) {
  for (const l of (await readJsonlFrom(f, 0)).lines) {
    const c = classifyClaudeRecord(parseJsonLine(l.text));
    if (c.kind !== 'assistant') continue;
    const m = c.rec.message;
    if (!m?.id || !m.usage || seen.has(m.id) || m.model === '<synthetic>') continue;
    seen.add(m.id);
    const u = m.usage as Record<string, number>;
    usages.push({
      ts: Date.parse(c.rec.timestamp),
      model: String(m.model),
      tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    });
  }
}
usages.sort((a, b) => a.ts - b.ts);
// 5h blocks: a block starts at the first message (floored to the hour) and lasts 5h
const blocks: Array<{ start: number; end: number; tokens: number; msgs: number }> = [];
for (const u of usages) {
  const b = blocks.at(-1);
  if (!b || u.ts >= b.end) {
    const start = Math.floor(u.ts / 3600_000) * 3600_000;
    blocks.push({ start, end: start + 5 * 3600_000, tokens: u.tokens, msgs: 1 });
  } else {
    b.tokens += u.tokens;
    b.msgs++;
  }
}
const current = blocks.at(-1);
console.log({
  weekTokens: usages.reduce((s, u) => s + u.tokens, 0),
  blocks: blocks.length,
  current: current && {
    start: new Date(current.start).toISOString(),
    resetsInMin: Math.round((current.end - Date.now()) / 60000),
    tokens: current.tokens,
    msgs: current.msgs,
  },
});
