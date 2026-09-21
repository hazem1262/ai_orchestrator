import { emptyUsage, type Session, type Source } from '@orc/core';

/**
 * A live session the indexer has not written a row for yet (a `claude` or `codex` process the
 * user started seconds ago). The board still has to render a card for it, so the tracker merges
 * its live state onto this minimal `Session` instead of dropping the session until the next
 * index pass. Every aggregate field is left at its empty value rather than guessed.
 */
export function stubSession(i: {
  source: Source;
  id: string;
  cwd: string;
  startedAt: string;
  projectId: string | null;
  name: string | null;
}): Session {
  return {
    id: i.id,
    source: i.source,
    projectId: i.projectId,
    startCwd: i.cwd,
    cwds: [i.cwd],
    name: i.name,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: i.startedAt,
    lastActivityAt: i.startedAt,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: null,
    lastTest: null,
    live: null,
  };
}
