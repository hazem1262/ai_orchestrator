import { z } from 'zod';

export const ProjectConfig = z
  .object({
    id: z.string(), // slug, e.g. "wakecap"
    name: z.string(),
    pathPrefixes: z.array(z.string()), // absolute paths
    hidden: z.boolean().default(false),
    openIn: z.enum(['vscode', 'terminal', 'finder']).default('vscode'),
    ticketRegex: z.string().nullable().default(null), // e.g. "\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b"
    prodPatterns: z.array(z.string()).default([]),
    features: z
      .object({
        workStreams: z.boolean().default(false),
        prodBadges: z.boolean().default(false),
        recaps: z.boolean().default(true),
      })
      .prefault({}),
    repos: z
      .array(
        z.object({
          path: z.string(),
          setup: z.string().optional(),
          run: z.string().optional(),
          archive: z.string().optional(),
          copyGlobs: z.array(z.string()).default([]),
          worktreeDir: z.string().default('.worktrees'),
        }),
      )
      .default([]),
    budgets: z
      .object({
        dailyUsd: z.number().optional(),
        weeklyUsd: z.number().optional(),
        monthlyUsd: z.number().optional(),
      })
      .prefault({}),
    maxConcurrentOwned: z.number().int().positive().default(6),
  })
  .strict();
export const OrcConfig = z
  .object({
    port: z.number().int().default(4317),
    defaultProjectId: z.string().default('wakecap'),
    resumeProfile: z
      .object({
        claudeCommand: z.string().default('claude'),
        claudeArgs: z.array(z.string()).default(['--dangerously-skip-permissions']),
        codexCommand: z.string().default('codex'),
        codexArgs: z.array(z.string()).default([]),
      })
      .prefault({}),
    projects: z.array(ProjectConfig).default([]),
    codex: z.object({ showAutomated: z.boolean().default(false) }).prefault({}),
    recaps: z
      .object({
        enabled: z.boolean().default(false),
        trigger: z.enum(['manual', 'on_idle', 'daily']).default('manual'),
        engine: z.enum(['claude-cli', 'anthropic-api']).default('claude-cli'),
        autoModel: z.string().default('claude-haiku-4-5'),
        onDemandModel: z.string().default('claude-sonnet-5'),
        monthlyBudgetUsd: z.number().default(20),
        maxInputTokens: z.number().default(30000),
        minPrompts: z.number().default(2),
        language: z.string().default('en'),
        promptTemplate: z.string().nullable().default(null),
      })
      .prefault({}),
    notifications: z
      .record(
        z.string(),
        z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) }),
      )
      .default({}),
    archive: z.object({ enabled: z.boolean().default(true), maxGb: z.number().default(10) }).prefault({}),
    live: z
      .object({
        pollMs: z.number().int().positive().default(1000),
        endedRetentionMin: z.number().int().positive().default(10),
        codexBusyWindowMs: z.number().int().positive().default(10000),
      })
      .prefault({}),
  })
  .strict();
export type OrcConfig = z.infer<typeof OrcConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
