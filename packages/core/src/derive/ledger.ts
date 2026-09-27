import type { TimelineEvent, ToolKind, Usage } from '../types/index.ts';

export interface LedgerUsageFact {
  agentKey: string;
  messageId: string;
  ts: string;
  model: string;
  usage: Usage;
  latencyMs: number | null;
}
export interface LedgerToolFact {
  agentKey: string;
  factKey: string;
  ts: string;
  kind: ToolKind;
  name: string;
  toolUseId: string | null;
}
export interface LedgerExtract {
  usage: LedgerUsageFact[];
  tools: LedgerToolFact[];
  toolResults: Array<{ toolUseId: string; ts: string }>;
  lastTs: string | null;
}

const SLASH = /^\/([A-Za-z0-9][\w:-]*)/;

function skillOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = (input as Record<string, unknown>).skill;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Pure: turns a batch of timeline events (one transcript, seq order) into ledger facts. Never copies text. */
export function extractLedgerFacts(
  events: TimelineEvent[],
  agentKey: string,
  prevTs: string | null,
): LedgerExtract {
  const out: LedgerExtract = { usage: [], tools: [], toolResults: [], lastTs: prevTs };
  let prev: { ts: string; messageId: string | null } | null = prevTs ? { ts: prevTs, messageId: null } : null;
  for (const ev of events) {
    if (ev.usage && ev.messageId && ev.model && ev.model !== '<synthetic>') {
      const latency =
        prev && prev.messageId !== ev.messageId ? Date.parse(ev.ts) - Date.parse(prev.ts) : null;
      out.usage.push({
        agentKey,
        messageId: ev.messageId,
        ts: ev.ts,
        model: ev.model,
        usage: ev.usage,
        latencyMs: latency !== null && latency >= 0 ? latency : null,
      });
    }
    if (ev.kind === 'prompt' && ev.text) {
      const m = SLASH.exec(ev.text.trim());
      if (m?.[1]) {
        out.tools.push({
          agentKey,
          factKey: `prompt:${ev.ts}:skill:${m[1]}`,
          ts: ev.ts,
          kind: 'skill',
          name: m[1],
          toolUseId: null,
        });
      }
    }
    if (ev.kind === 'tool_call' && ev.tool) {
      const skill = ev.tool === 'Skill' ? skillOf(ev.input) : null;
      const kind: ToolKind = skill ? 'skill' : ev.mcpServer ? 'mcp' : 'tool';
      const name = skill ?? ev.mcpServer ?? ev.tool;
      const id = ev.toolUseId ?? `seq${ev.seq}`;
      out.tools.push({
        agentKey,
        factKey: `${id}:${kind}:${name}`,
        ts: ev.ts,
        kind,
        name,
        toolUseId: ev.toolUseId,
      });
    }
    if (ev.kind === 'tool_result' && ev.toolUseId)
      out.toolResults.push({ toolUseId: ev.toolUseId, ts: ev.ts });
    prev = { ts: ev.ts, messageId: ev.messageId };
    out.lastTs = ev.ts;
  }
  return out;
}
