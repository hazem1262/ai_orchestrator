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
export const RecapsConfig = z.object({
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
  idleMinutes: z.number().int().positive().default(10), // on_idle debounce
  excludeProjectIds: z.array(z.string()).default([]),
  dailyProjectIds: z.array(z.string()).default(['wakecap']), // daily recap targets
});
export const LimitsConfig = z.object({
  // Spike S7 (plan/spikes/S7.md) chose `official`: the statusLine stdin JSON carries `rate_limits`.
  quotaSource: z.enum(['estimate', 'official']).default('official'),
  officialFieldPaths: z
    .object({
      blockPct: z.string().nullable().default('rate_limits.five_hour.used_percentage'),
      blockResetsAt: z.string().nullable().default('rate_limits.five_hour.resets_at'),
      weekPct: z.string().nullable().default('rate_limits.seven_day.used_percentage'),
      weekResetsAt: z.string().nullable().default('rate_limits.seven_day.resets_at'),
    })
    .prefault({}),
  blockTokenLimit: z.number().int().positive().nullable().default(null), // user plan limit (5h)
  weekTokenLimit: z.number().int().positive().nullable().default(null), // user plan limit (7d)
  warnPct: z.number().min(0).max(1).default(0.8),
  contextWindows: z
    .record(z.string(), z.number().int().positive())
    .default({ 'claude-opus-5': 1000000, 'claude-sonnet-5': 1000000, 'claude-haiku-4-5': 200000 }),
  defaultContextWindow: z.number().int().positive().default(200000),
  // USD per 1M tokens (Anthropic first-party list prices, checked 2026-09-17; cache write =
  // 1.25 x input (5-min TTL), cache read = 0.1 x input). Used only for estimates.
  pricing: z
    .record(
      z.string(),
      z.object({ input: z.number(), output: z.number(), cacheWrite: z.number(), cacheRead: z.number() }),
    )
    .default({
      'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    }),
  contextWarnFill: z.number().min(0).max(1).default(0.85),
});
export const DigestConfig = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().default('0 9 * * 1'), // weekly digest, Mon 09:00 local
  dailyRecapCron: z.string().default('0 19 * * 1-5'), // daily project recap
});
export const HooksConfig = z.object({ statusOverrideMs: z.number().int().positive().default(120000) });
export type RecapsConfig = z.infer<typeof RecapsConfig>;
export type LimitsConfig = z.infer<typeof LimitsConfig>;
export type DigestConfig = z.infer<typeof DigestConfig>;
export type HooksConfig = z.infer<typeof HooksConfig>;

export const RemoteConfig = z.object({
  enabled: z.boolean().default(false),
  origin: z.string().nullable().default(null), // e.g. "https://mac.tail1234.ts.net" (no trailing slash)
  allowedLogin: z.string().nullable().default(null), // Tailscale-User-Login that may use the app remotely
  stepUpTtlSec: z.number().int().positive().default(300),
  pairingTtlSec: z.number().int().positive().default(300),
});
export const AwayConfig = z.object({
  auto: z.boolean().default(true),
  idleMinutes: z.number().int().positive().default(10),
  channels: z.array(z.enum(['webpush', 'slack_dm'])).default(['webpush', 'slack_dm']),
});
export const ConnectorsConfig = z.object({
  linear: z
    .object({
      enabled: z.boolean().default(true),
      defaultTeamKey: z.string().nullable().default(null),
      pollSeconds: z.number().int().min(30).default(120),
      redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/linear/callback'),
    })
    .prefault({}),
  slack: z
    .object({
      enabled: z.boolean().default(true),
      redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/slack/callback'),
      dailyChannel: z.string().nullable().default(null),
      pollSeconds: z.number().int().min(30).default(60),
      dmBridge: z.boolean().default(true),
      bridgePollSeconds: z.number().int().min(5).default(15),
      // Spike S9 (plan/spikes/S9.md): the self-DM is assumed to notify; flip to true if check g2 fails and g4 passes.
      nudgeViaReminder: z.boolean().default(false),
    })
    .prefault({}),
});
export type RemoteConfig = z.infer<typeof RemoteConfig>;
export type AwayConfig = z.infer<typeof AwayConfig>;
export type ConnectorsConfig = z.infer<typeof ConnectorsConfig>;

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
    recaps: RecapsConfig.prefault({}),
    limits: LimitsConfig.prefault({}),
    digest: DigestConfig.prefault({}),
    hooks: HooksConfig.prefault({}),
    remote: RemoteConfig.prefault({}),
    away: AwayConfig.prefault({}),
    connectors: ConnectorsConfig.prefault({}),
    notifications: z
      .record(
        z.string(),
        z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) }),
      )
      .default({}),
    archive: z.object({ enabled: z.boolean().default(true), maxGb: z.number().default(10) }).prefault({}),
    automations: z
      .object({
        enabled: z.boolean().default(false),
        maxConcurrent: z.number().int().positive().default(2),
        suggestions: z
          .object({
            enabled: z.boolean().default(false),
            intervalMin: z.number().int().positive().default(60),
          })
          .prefault({}),
      })
      .prefault({}),
    supervisor: z
      .object({
        enabled: z.boolean().default(false),
        model: z.string().default('claude-haiku-4-5'),
        confidenceThreshold: z.number().min(0).max(1).default(0.85),
        maxPerSessionPerHour: z.number().int().nonnegative().default(3),
        maxPerHour: z.number().int().nonnegative().default(10),
        monthlyBudgetUsd: z.number().nonnegative().default(5),
        quietHours: z
          .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
          .nullable()
          .default(null),
        debounceMs: z.number().int().nonnegative().default(3000),
      })
      .prefault({}),
    compare: z.object({ maxVariants: z.number().int().min(2).max(6).default(4) }).prefault({}),
    agnc: z
      .object({
        enabled: z.boolean().default(false),
        url: z.string().default('https://agnc.wakecap.ai/mcp'),
        pollSeconds: z.number().int().positive().default(30),
      })
      .prefault({}),
    github: z
      .object({
        enabled: z.boolean().default(true),
        pollSeconds: z.number().int().min(30).default(90),
        ticketUrlTemplate: z.string().default('https://linear.app/wakecap/issue/{ticket}'),
        protectedBranches: z
          .array(z.string())
          .default(['main', 'master', 'develop', 'staging', 'testing', 'production']),
      })
      .prefault({}),
    worktrees: z
      .object({
        autoArchiveOnMerge: z.boolean().default(true),
        scratchpadRoots: z.array(z.string()).default(['/private/tmp']),
        scanSiblings: z.boolean().default(true),
        implementTicketMode: z.enum(['precreate', 'conductor']).default('conductor'),
        checkpointsPerSession: z.number().int().positive().default(200),
      })
      .prefault({}),
    safety: z
      .object({
        extraDenyPatterns: z.array(z.string()).default([]),
        prodSkills: z
          .array(z.string())
          .default(['production_server_db', 'production_server_logs', 'wecare_production_db']),
        secretScanPaths: z
          .array(z.string())
          .default(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']),
      })
      .prefault({}),
    links: z
      .object({
        linearWorkspace: z.string().nullable().default(null),
        planRoots: z.array(z.string()).default(['~/Wakecap/plans']),
      })
      .prefault({}),
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
