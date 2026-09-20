import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Mirror of config projects (the config file is the source of truth). */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pathPrefixesJson: text('path_prefixes_json').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    pk: text('pk').primaryKey(),
    source: text('source').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id'),
    startCwd: text('start_cwd').notNull(),
    name: text('name'),
    firstPrompt: text('first_prompt'),
    lastPrompt: text('last_prompt'),
    recap: text('recap'),
    startedAt: text('started_at').notNull(),
    lastActivityAt: text('last_activity_at').notNull(),
    costUsd: real('cost_usd'),
    modelsJson: text('models_json').notNull().default('[]'),
    ticketsJson: text('tickets_json').notNull().default('[]'),
    prsJson: text('prs_json').notNull().default('[]'),
    skillsJson: text('skills_json').notNull().default('[]'),
    availability: text('availability').notNull(),
    hasSubagents: integer('has_subagents', { mode: 'boolean' }).notNull().default(false),
    touchedProd: integer('touched_prod', { mode: 'boolean' }).notNull().default(false),
    automated: integer('automated', { mode: 'boolean' }).notNull().default(false),
    transcriptPath: text('transcript_path'),
    origin: text('origin').notNull().default('transcript'),
    dataJson: text('data_json').notNull(),
    indexedAt: text('indexed_at').notNull(),
  },
  (t) => [
    uniqueIndex('sessions_source_id').on(t.source, t.id),
    index('sessions_activity').on(t.lastActivityAt),
    index('sessions_project_activity').on(t.projectId, t.lastActivityAt),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionPk: text('session_pk').notNull(),
    agentId: text('agent_id').notNull().default(''),
    seq: integer('seq').notNull(),
    uuid: text('uuid').notNull(),
    parentUuid: text('parent_uuid'),
    ts: text('ts').notNull(),
    kind: text('kind').notNull(),
    turn: integer('turn').notNull(),
    text: text('text'),
    tool: text('tool'),
    toolUseId: text('tool_use_id'),
    mcpServer: text('mcp_server'),
    inputJson: text('input_json'),
    searchInput: text('search_input'),
    messageId: text('message_id'),
    model: text('model'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    uniqueIndex('events_session_agent_seq').on(t.sessionPk, t.agentId, t.seq),
    index('events_session_turn').on(t.sessionPk, t.turn),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    sessionPk: text('session_pk').notNull(),
    id: text('id').notNull(),
    parentId: text('parent_id'),
    depth: integer('depth').notNull(),
    agentType: text('agent_type').notNull(),
    description: text('description').notNull(),
    background: integer('background', { mode: 'boolean' }).notNull().default(false),
    toolUseId: text('tool_use_id'),
    usageJson: text('usage_json').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(),
    transcriptPath: text('transcript_path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.id] })],
);

export const fileOffsets = sqliteTable('file_offsets', {
  path: text('path').primaryKey(),
  kind: text('kind').notNull(),
  sessionPk: text('session_pk'),
  agentId: text('agent_id'),
  size: integer('size').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  offset: integer('offset').notNull(),
  stateJson: text('state_json'),
  updatedAt: text('updated_at').notNull(),
});

export const historyPrompts = sqliteTable(
  'history_prompts',
  {
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    display: text('display').notNull(),
    project: text('project').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.ts] })],
);

export const labels = sqliteTable(
  'labels',
  {
    sessionPk: text('session_pk').notNull(),
    label: text('label').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.label] }), index('labels_label').on(t.label)],
);

export const pins = sqliteTable('pins', {
  sessionPk: text('session_pk').primaryKey(),
  createdAt: text('created_at').notNull(),
});

export const savedViews = sqliteTable('saved_views', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  queryJson: text('query_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const ptySessions = sqliteTable('pty_sessions', {
  id: text('id').primaryKey(),
  sessionPk: text('session_pk'),
  command: text('command').notNull(),
  argsJson: text('args_json').notNull(),
  cwd: text('cwd').notNull(),
  pid: integer('pid').notNull(),
  startedAt: text('started_at').notNull(),
  exitedAt: text('exited_at'),
  exitCode: integer('exit_code'),
});
