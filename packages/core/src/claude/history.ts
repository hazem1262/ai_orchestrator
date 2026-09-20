import { deriveName } from '../derive/name.ts';
import { slashCommand } from '../derive/skills.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { Session } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';

export interface HistoryPrompt {
  sessionId: string;
  ts: string;
  display: string;
  project: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of ~/.claude/history.jsonl. `pastedContents` is deliberately dropped (may contain secrets). */
export function parseHistoryLine(value: unknown): HistoryPrompt | null {
  if (!isObj(value)) return null;
  const { sessionId, project, display, timestamp } = value;
  const ms =
    typeof timestamp === 'number'
      ? timestamp
      : typeof timestamp === 'string'
        ? Number(timestamp)
        : Number.NaN;
  if (typeof sessionId !== 'string' || typeof project !== 'string' || typeof display !== 'string')
    return null;
  if (!Number.isFinite(ms)) return null;
  return { sessionId, project, display, ts: new Date(ms).toISOString() };
}

export function historyPromptsToSession(
  prompts: HistoryPrompt[],
  o: { projectId: string | null; ticketRegex: RegExp | null },
): Session | null {
  const sorted = [...prompts].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  const cwds: string[] = [];
  const tickets: string[] = [];
  const skills: string[] = [];
  for (const p of sorted) {
    addUnique(cwds, [p.project]);
    addUnique(tickets, extractTickets(p.display, o.ticketRegex));
    const cmd = slashCommand(p.display);
    if (cmd) addUnique(skills, [cmd]);
  }
  return {
    id: first.sessionId,
    source: 'claude',
    projectId: o.projectId,
    startCwd: first.project,
    cwds,
    name: deriveName({
      agentName: null,
      customTitle: null,
      aiTitle: null,
      summary: null,
      firstPrompt: first.display,
    }),
    firstPrompt: first.display,
    lastPrompt: last.display,
    awaySummary: null,
    recap: null,
    startedAt: first.ts,
    lastActivityAt: last.ts,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets,
    skills,
    mcpServers: [],
    filesTouched: [],
    promptCount: sorted.length,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'prompts-only',
    transcriptPath: null,
    lastTest: null,
    live: null,
  };
}
