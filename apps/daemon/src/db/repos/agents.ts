import type { AgentNode, Usage } from '@orc/core';
import { asc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { splitPk } from '../keys.ts';
import { agents } from '../schema.ts';

export function upsertAgent(db: OrcDb, sessionPk: string, n: AgentNode): void {
  const row = {
    sessionPk,
    id: n.id,
    parentId: n.parentId,
    depth: n.depth,
    agentType: n.agentType,
    description: n.description,
    background: n.background,
    toolUseId: n.toolUseId,
    usageJson: JSON.stringify(n.usage),
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    status: n.status,
    transcriptPath: n.transcriptPath,
  };
  db.insert(agents)
    .values(row)
    .onConflictDoUpdate({ target: [agents.sessionPk, agents.id], set: row })
    .run();
}

export function listAgents(db: OrcDb, sessionPk: string): AgentNode[] {
  return db
    .select()
    .from(agents)
    .where(eq(agents.sessionPk, sessionPk))
    .orderBy(asc(agents.startedAt))
    .all()
    .map((r) => ({
      id: r.id,
      sessionId: splitPk(r.sessionPk).id,
      parentId: r.parentId,
      depth: r.depth,
      agentType: r.agentType,
      description: r.description,
      background: r.background,
      toolUseId: r.toolUseId,
      usage: JSON.parse(r.usageJson) as Usage,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status as AgentNode['status'],
      transcriptPath: r.transcriptPath,
    }));
}
