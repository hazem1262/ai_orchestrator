import type {
  AgentNode,
  LiveState,
  Project,
  PrRef,
  Session,
  TestResult,
  TimelineEvent,
  Usage,
} from '@orc/core';
import { z } from 'zod';

export const SourceSchema = z.enum(['claude', 'codex', 'agnc']);
export const AvailabilitySchema = z.enum(['resumable', 'archived', 'prompts-only', 'remote']);
export const LiveStatusSchema = z.enum([
  'busy',
  'idle',
  'waiting',
  'shell',
  'review',
  'blocked',
  'error',
  'ended',
]);
export const EventKindSchema = z.enum([
  'prompt',
  'assistant_text',
  'thinking',
  'tool_call',
  'tool_result',
  'system',
  'error',
]);

export const UsageSchema: z.ZodType<Usage> = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});

export const PrRefSchema: z.ZodType<PrRef> = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
});

export const TestResultSchema: z.ZodType<TestResult> = z.object({
  ts: z.string(),
  command: z.string(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number().nullable(),
});

export const LiveStateSchema: z.ZodType<LiveState> = z.object({
  pid: z.number().int().nullable(),
  status: LiveStatusSchema,
  waitingFor: z.string().nullable(),
  since: z.string(),
  ownership: z.enum(['observed', 'owned']),
  ptyId: z.string().nullable(),
  stage: z.enum(['understand', 'modify', 'test', 'review']).nullable(),
  currentTool: z.string().nullable(),
  backgroundJobs: z.number().int(),
  runningSubagents: z.number().int(),
  contextFill: z.number().nullable(),
});

export const SessionSchema: z.ZodType<Session> = z.object({
  id: z.string(),
  source: SourceSchema,
  projectId: z.string().nullable(),
  startCwd: z.string(),
  cwds: z.array(z.string()),
  name: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  lastPrompt: z.string().nullable(),
  awaySummary: z.string().nullable(),
  recap: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  models: z.array(z.string()),
  permissionMode: z.string().nullable(),
  usage: UsageSchema,
  linesAdded: z.number().nullable(),
  linesRemoved: z.number().nullable(),
  prs: z.array(PrRefSchema),
  tickets: z.array(z.string()),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  filesTouched: z.array(z.string()),
  promptCount: z.number().int(),
  toolCallCount: z.number().int(),
  apiErrorCount: z.number().int(),
  flags: z.object({ touchedProd: z.boolean(), hasSubagents: z.boolean(), automated: z.boolean() }),
  availability: AvailabilitySchema,
  transcriptPath: z.string().nullable(),
  lastTest: TestResultSchema.nullable(),
  live: LiveStateSchema.nullable(),
});

export const TimelineEventSchema: z.ZodType<TimelineEvent> = z.object({
  sessionId: z.string(),
  agentId: z.string().nullable(),
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  seq: z.number().int(),
  ts: z.string(),
  kind: EventKindSchema,
  turn: z.number().int(),
  text: z.string().nullable(),
  tool: z.string().nullable(),
  toolUseId: z.string().nullable(),
  mcpServer: z.string().nullable(),
  input: z.unknown(),
  messageId: z.string().nullable(),
  model: z.string().nullable(),
  usage: UsageSchema.nullable(),
  durationMs: z.number().nullable(),
});

export const AgentNodeSchema: z.ZodType<AgentNode> = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int(),
  agentType: z.string(),
  description: z.string(),
  background: z.boolean(),
  toolUseId: z.string().nullable(),
  usage: UsageSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(['running', 'done', 'error']),
  transcriptPath: z.string(),
});

export const ProjectSchema: z.ZodType<Project> = z.object({
  id: z.string(),
  name: z.string(),
  pathPrefixes: z.array(z.string()),
  hidden: z.boolean(),
  lastActivityAt: z.string().nullable(),
  sessionCount: z.number().int(),
});
