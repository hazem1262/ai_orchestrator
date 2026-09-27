import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['reminder', 'automation', 'digest'] }).notNull(),
  cron: text('cron'),
  runAt: text('run_at'),
  payloadJson: text('payload_json').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastFiredAt: text('last_fired_at'),
  createdAt: text('created_at').notNull(),
});

export const usageEntries = sqliteTable(
  'usage_entries',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(), // '' = main transcript
    messageId: text('message_id').notNull(), // 'session-total' = synthetic per-session entry
    ts: text('ts').notNull(),
    source: text('source').notNull(),
    projectId: text('project_id'),
    ticketsJson: text('tickets_json').notNull().default('[]'),
    model: text('model').notNull(),
    input: integer('input').notNull(),
    output: integer('output').notNull(),
    cacheRead: integer('cache_read').notNull(),
    cacheWrite: integer('cache_write').notNull(),
    estCostUsd: real('est_cost_usd').notNull().default(0),
    allocCostUsd: real('alloc_cost_usd').notNull().default(0),
    authoritative: integer('authoritative', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionPk, t.agentKey, t.messageId] }),
    index('usage_entries_ts').on(t.ts),
    index('usage_entries_project_ts').on(t.projectId, t.ts),
  ],
);

export const toolUses = sqliteTable(
  'tool_uses',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(),
    factKey: text('fact_key').notNull(),
    ts: text('ts').notNull(),
    kind: text('kind', { enum: ['tool', 'mcp', 'skill'] }).notNull(),
    name: text('name').notNull(),
    toolUseId: text('tool_use_id'),
    projectId: text('project_id'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionPk, t.agentKey, t.factKey] }),
    index('tool_uses_ts').on(t.ts),
    index('tool_uses_tool_use_id').on(t.toolUseId),
  ],
);

export const ledgerCursors = sqliteTable(
  'ledger_cursors',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(),
    afterSeq: integer('after_seq').notNull(),
    lastTs: text('last_ts'),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.agentKey] })],
);

export const usageBlocks = sqliteTable('usage_blocks', {
  start: text('start').primaryKey(),
  end: text('end').notNull(),
  tokens: integer('tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  entries: integer('entries').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type', { enum: ['global', 'project', 'ticket'] }).notNull(),
    scopeId: text('scope_id').notNull().default(''), // '' for global
    period: text('period', { enum: ['daily', 'weekly', 'monthly'] }).notNull(),
    limitUsd: real('limit_usd').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('budgets_scope_period').on(t.scopeType, t.scopeId, t.period)],
);

export const streams = sqliteTable('streams', {
  ticket: text('ticket').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title'),
  stage: text('stage', {
    enum: ['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released'],
  }).notNull(),
  sessionIdsJson: text('session_ids_json').notNull().default('[]'),
  prsJson: text('prs_json').notNull().default('[]'),
  plansJson: text('plans_json').notNull().default('[]'),
  worktreesJson: text('worktrees_json').notNull().default('[]'),
  costUsd: real('cost_usd').notNull().default(0),
  lastActivityAt: text('last_activity_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const streamLinks = sqliteTable(
  'stream_links',
  {
    ticket: text('ticket').notNull(),
    kind: text('kind', { enum: ['session', 'pr', 'plan', 'worktree', 'workflow'] }).notNull(),
    ref: text('ref').notNull(),
    origin: text('origin', { enum: ['auto', 'manual'] }).notNull(),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticket, t.kind, t.ref] }), index('stream_links_ref').on(t.kind, t.ref)],
);

export const recaps = sqliteTable(
  'recaps',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['session', 'daily', 'handoff'] }).notNull(),
    targetKey: text('target_key').notNull(), // session pk, or `${projectId}:${date}`
    transcriptOffset: integer('transcript_offset').notNull(),
    model: text('model').notNull(),
    engine: text('engine', { enum: ['claude-cli', 'anthropic-api'] }).notNull(),
    text: text('text').notNull(),
    costUsd: real('cost_usd').notNull(),
    inputTokensApprox: integer('input_tokens_approx').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('recaps_cache_key').on(t.kind, t.targetKey, t.transcriptOffset),
    index('recaps_created_at').on(t.createdAt),
  ],
);

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type', { enum: ['session', 'stream'] }).notNull(),
    targetId: text('target_id').notNull(),
    objective: text('objective').notNull(),
    state: text('state', { enum: ['active', 'paused', 'blocked', 'complete'] }).notNull(),
    blockedReason: text('blocked_reason'),
    source: text('source', { enum: ['manual', 'rule', 'recap'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('goals_target').on(t.targetType, t.targetId)],
);

export const handoffs = sqliteTable(
  'handoffs',
  {
    id: text('id').primaryKey(),
    sessionPk: text('session_pk').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    filesJson: text('files_json').notNull(),
    nextStepsJson: text('next_steps_json').notNull(),
    blockersJson: text('blockers_json').notNull(),
    linksJson: text('links_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('handoffs_session').on(t.sessionPk, t.createdAt)],
);

export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    sessionPk: text('session_pk'),
    ticket: text('ticket'),
    text: text('text').notNull(),
    dueAt: text('due_at').notNull(),
    sendToSession: integer('send_to_session', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { enum: ['pending', 'fired', 'cancelled'] }).notNull(),
    createdAt: text('created_at').notNull(),
    firedAt: text('fired_at'),
  },
  (t) => [index('reminders_state_due').on(t.state, t.dueAt)],
);

export const digests = sqliteTable('digests', {
  weekStart: text('week_start').primaryKey(),
  markdown: text('markdown').notNull(),
  createdAt: text('created_at').notNull(),
});
