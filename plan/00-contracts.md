# 00 — Shared Contracts

> **Every phase plan must follow this file.** It is the single source of truth for names, types, paths, routes and conventions. When a phase needs something new, it adds it under that phase's "Contract additions". The addition is merged into this file at the end of the phase, in the same PR.
>
> Spec: `docs/` (README, 01–06). Features are referred to by ID (`F1`–`F24`) from `docs/02-features.md`.

---

## 1. Tooling & versions (checked with `npm view`, 2026-09-17)

| Tool | Version pin | Notes |
|---|---|---|
| Node | `>=22.12 <23` (local: 22.20.0) | `engines` in root `package.json`; `.nvmrc` = `22` |
| pnpm | `10.18.3` | `packageManager` field in root `package.json` |
| TypeScript | `~6.0.3` | TS 7 (native) is `latest`, but we stay on the JS-based compiler for tool compatibility. Upgrading is a separate task later. |
| Vitest | `^5.0.1` | workspace projects |
| Biome | `^2.5.14` | lint and format (replaces ESLint and Prettier) |
| tsx | `^4.23.13` | dev runner for the daemon |
| tsup | `^8.5.1` | daemon bundle |

**Daemon runtime dependencies**

| Package | Version |
|---|---|
| hono | `^4.13.8` |
| @hono/node-server | `^2.1.1` |
| ws | `^8.21.3` |
| better-sqlite3 | `^13.0.3` |
| drizzle-orm | `^0.45.2` |
| drizzle-kit | `^0.31.10` (dev dependency) |
| node-pty | `^1.1.0` |
| chokidar | `^5.0.0` |
| zod | `^4.6.5` |
| pino | `^10.3.1` |
| execa | `^10.0.1` |
| croner | `^10.0.1` (used from P5: `services/scheduler/scheduler.ts`) |
| @anthropic-ai/sdk | `^0.128.0` (P5: the `anthropic-api` recap engine) |
| web-push | `^3.6.7` (P6: installed 3.6.7) |
| @types/web-push | `^3.6.4` (dev dependency, P6) |
| @simplewebauthn/server | `^14.0.2` (P6: installed 14.0.3) |
| @modelcontextprotocol/sdk | `^1.30.0` (P7: installed 1.30.1; the AGNC connector's Streamable HTTP client) |
| @linear/sdk | `^95.1.0` (P6: installed 95.2.0; 96.0.0 exists and was not adopted) |
| @slack/web-api | `^8.1.1` |
| node-notifier | `^10.0.1` |
| @napi-rs/keyring | `^2.1.0` (P6: `services/secrets/secret-store.ts`, service `orchestrator`) |

**Web runtime dependencies**

| Package | Version |
|---|---|
| react / react-dom | `^19.3.0` |
| vite | `^8.3.0` |
| @vitejs/plugin-react | latest |
| tailwindcss + @tailwindcss/vite | `^4.3.3` |
| @tanstack/react-query | `^5.103.1` |
| @tanstack/react-router | `^1.170.38` |
| @tanstack/react-table | `^9.2.4` |
| @tanstack/react-virtual | `^3.14.13` |
| zustand | `^5.0.15` |
| @xterm/xterm | `^6.0.0` |
| @xterm/addon-fit | `^0.11.0` |
| @xyflow/react | `^12.11.6` |
| echarts | `^6.1.0` |
| cmdk | `^1.1.1` |
| react-resizable-panels | `^4.12.4` |
| @git-diff-view/react | `^0.1.7` |
| vite-plugin-pwa | `^1.3.0` (P6: installed 1.3.0; dev dependency, `injectManifest` with `src/sw.ts`) |
| @simplewebauthn/browser | `^14.0.0` (P6: installed 14.0.0) |
| workbox-precaching | `^7.4.1` (P6, used by `src/sw.ts`) |
| workbox-build | `^7.4.1` (dev dependency, P6: peer of vite-plugin-pwa) |
| workbox-window | `^7.4.1` (dev dependency, P6: peer of vite-plugin-pwa) |
| @playwright/test | `^1.63.0` (e2e) |
| @testing-library/jest-dom | `^7.0.1` (dev dependency, P5: loaded by `src/test/setup.ts`) |

The daemon package also ships a `bin` entry, `orc-statusline` → `dist/orc-statusline.js` (P5), built by tsup next to `dist/main.js`.

**P7 packages (as built)**

| Package | Dependency | Version |
|---|---|---|
| `@orc/mcp` (`apps/mcp`) | @modelcontextprotocol/sdk | `^1.30.0` (installed 1.30.1) |
| | zod | `^4.6.5` (installed 4.6.5) |
| | @orc/core | `workspace:*` |
| | tsup, tsx (dev) | `^8.5.1` (8.5.1), `^4.23.13` (4.23.13) |
| `@orc/desktop` (`apps/desktop`, npm) | @tauri-apps/cli (dev) | `^2.11.4` (installed 2.12.0) |
| `orchestrator-desktop` (`apps/desktop/src-tauri/Cargo.toml`) | tauri | `2`, feature `tray-icon` |
| | tauri-build (build dependency) | `2` |
| | tauri-plugin-shell, tauri-plugin-notification | `2` |
| | tauri-plugin-global-shortcut | `2` (macOS, Windows and Linux targets only) |
| | reqwest | `0.12`, `default-features = false`, features `json`, `rustls-tls` |
| | tokio | `1`, feature `time` |
| | serde (feature `derive`), serde_json | `1` |

`@orc/mcp` ships the `bin` `orc-mcp` → `dist/main.js`. `@orc/desktop` is version `0.7.0` and has the scripts `sidecar`, `dev:app`, `build:app` (both run `node ../../scripts/build-sidecar.mjs` first) and `test:rust` (`cargo test`). **No Rust crate version is resolved yet:** Rust is not installed on the dev machine, so there is no `Cargo.lock` and the crates have never been built.

**UI kit:** **shadcn/ui** — primitives copied into `apps/web/src/components/ui/` and owned by this repo (MIT, no registry auth, no private dependency). All UI code imports from `@/components/ui/*` and never from a vendor path, so swapping kits later touches that one folder and nothing else.

## 2. Repository layout

```
orchestrator/
├─ package.json                 # private root; scripts: build, test, lint, typecheck, dev
├─ pnpm-workspace.yaml          # packages: apps/*, packages/*
├─ tsconfig.base.json           # strict, ES2023, moduleResolution "bundler", verbatimModuleSyntax
├─ biome.json
├─ vitest.config.ts             # root config; uses `test.projects` to run packages/* and apps/*
├─ .nvmrc  .gitignore  .npmrc
├─ fixtures/                    # redacted sample data (see §9)
├─ scripts/                     # repo scripts (coverage checks, dry-runs)
├─ packages/
│  ├─ core/                     # @orc/core — pure TS: types, parsers, derivations, redaction. NO fs/net/process imports except in src/io/*
│  └─ api-contract/             # @orc/api-contract — zod schemas for HTTP/WS + typed client
├─ apps/
│  ├─ daemon/                   # @orc/daemon — Node service
│  ├─ web/                      # @orc/web — React UI (Vite)
│  ├─ mcp/                      # @orc/mcp — stdio MCP server `orc-mcp`, a thin client of the daemon HTTP API (P7)
│  └─ desktop/                  # @orc/desktop — Tauri 2 shell; runs the daemon as the sidecar `orc-node` + resources/daemon (P7)
├─ spikes/                      # throwaway spike code (Phase 0), not part of the build
├─ docs/                        # design docs (spec)
└─ plan/                        # these plans; plan/spikes/<id>.md spike reports
```

### Package internals (the pattern every phase follows)
```
packages/core/src/
  index.ts                  # re-exports only
  types/                    # domain types (§4), one file per aggregate
  claude/                   # Claude parsers: records.ts, session-aggregate.ts, history.ts, registry.ts, subagents.ts
  codex/                    # rollout.ts, codex-aggregate.ts
  derive/                   # tickets.ts, skills.ts, prod.ts, name.ts, stage.ts, tests.ts, cost.ts
  redact/                   # redact.ts
  io/                       # jsonl-tail.ts (the only fs-touching module in core)
apps/daemon/src/
  main.ts                   # boot
  config.ts                 # §3
  db/                       # schema.ts, client.ts, migrations/ (drizzle-kit output), repos/*.ts
  collectors/               # claude/, codex/, agnc/
  indexer/                  # indexer.ts, file-offsets.ts
  live/                     # registry-watcher.ts, liveness.ts, event-bus.ts
  pty/                      # pty-manager.ts, input.ts
  inbox/                    # engine.ts, rules/*.ts
  notify/                   # notifier.ts, macos.ts, webpush.ts, slack-dm.ts
  services/                 # archive/, worktree/, checkpoint/, ship/, recap/, handoff/, usage/, supervisor/, scheduler/, audit/
  connectors/               # github/, linear/, slack/, agnc/
  http/                     # app.ts (Hono), auth.ts, routes/*.ts, ws.ts
apps/web/src/
  main.tsx  router.tsx
  api/                      # client.ts (from api-contract), ws.ts, queries/*.ts
  stores/                   # zustand stores
  components/ui/            # re-export layer (§1)
  features/<feature>/       # e.g. features/history/, features/live-board/, features/inbox/ …
  routes/                   # TanStack Router file routes
```

**P4 folders (as built):**
```
packages/core/src/git/            # pure: worktree-porcelain.ts, branch.ts, diff-parse.ts, hunk-select.ts, review-prompt.ts, status-porcelain.ts, index.ts (barrel)
apps/daemon/src/services/git/     # exec.ts (git/gh wrappers + assertSafeGitArgs force guard), audit.ts (runAudited)
apps/daemon/src/services/diff/    # diff.ts
apps/daemon/src/services/review/  # review.ts, plan-approval.ts, plan-keys.ts
apps/daemon/src/services/worktree/# sources.ts, discover.ts, worktree-read.ts, worktree-write.ts, worktree-sync.ts, glob.ts, worktree.ts, auto-archive.ts
apps/daemon/src/services/checkpoint/ # checkpoint.ts, snapshot.ts, turn-hook.ts
apps/daemon/src/services/ship/    # ship.ts
apps/daemon/src/services/         # + launch-plan-mode.ts (applyPlanMode), launch-prepare.ts (prepareLaunch) beside P2's launch.ts — there is no services/launch/ folder
apps/daemon/src/connectors/github/# github.ts
apps/daemon/src/inbox/rules/      # + pr-event.ts, plan-approval.ts
apps/daemon/src/http/routes/      # + git-guard.ts, worktrees.ts, github.ts, review.ts, ship.ts, plan.ts
apps/web/src/features/worktrees/  apps/web/src/features/review/  apps/web/src/features/git/
```

**P7 folders (as built):**
```
apps/daemon/src/phase7.ts                    # createPhase7 + Phase7Options (the only P7 wiring point)
apps/daemon/src/services/automations/        # guardrails.ts, headless.ts, pty-wait.ts, service.ts, schedules.ts, triggers.ts, dispatcher.ts, suggestions.ts, types.ts
apps/daemon/src/services/compare/            # compare.ts
apps/daemon/src/services/supervisor/         # rules.ts, classifier.ts, supervisor.ts
apps/daemon/src/services/git/                # + git-info.ts (diffStat, addedLinesDiff, defaultBranch, remoteSlug) beside P4's exec.ts / audit.ts
apps/daemon/src/services/launch/             # spawn.ts (assertOwnedCapacity, spawnClaudeSession, spawnCodexSession) — P2's services/launch.ts stays where it is
apps/daemon/src/connectors/agnc/             # agnc.ts, oauth-provider.ts, normalize.ts
apps/daemon/src/collectors/agnc/             # agnc-collector.ts (remote-session poller)
apps/daemon/src/notify/stdout-bridge.ts      # ORC_NOTIFY_BRIDGE=stdout channel
apps/daemon/src/http/p7-guard.ts             # ConfirmBody, requireConfirmed, need, API_BASE, TEST_TOKEN
apps/daemon/src/http/routes/                 # + automations.ts, compare.ts, supervisor.ts, agnc.ts
apps/daemon/src/db/migrations/               # + 0010_phase7_automations.sql, 0011_phase7_compare.sql, 0012_phase7_supervisor.sql
packages/api-contract/src/routes/            # + automations.ts, compare.ts, supervisor.ts, agnc.ts, p7-common.ts (DiffStatSchema)
packages/api-contract/src/clients/           # automations.ts, compare.ts, supervisor.ts, agnc.ts, phase7.ts (phase7Client)
apps/web/src/features/                       # + automations/, compare/, supervisor/, agnc/
apps/mcp/src/                                # main.ts, server.ts, tools.ts, daemon-client.ts
apps/desktop/src-tauri/                      # Cargo.toml, tauri.conf.json, capabilities/default.json, src/{main,lib,bridge}.rs
scripts/build-sidecar.mjs                    # builds binaries/orc-node-<triple>, resources/daemon/, resources/web/ (needs rustc for the triple)
apps/daemon/test/fakes/phase7.ts             # P7 test fakes + offlinePhase7(); fakes/agnc-server.ts (in-memory AGNC MCP server)
```

## 3. Configuration & paths

- **`ORC_HOME`** defaults to `~/.orchestrator`. Tests always set it to a temp dir.
- **`CLAUDE_HOME`** defaults to `~/.claude`, and **`CODEX_HOME`** defaults to `~/.codex`. Tests point them at `fixtures/`.
- **`WSTACK_HOME`** (P5) defaults to `~/.wstack`; the stream service and wstack analytics read `<home>/workflows/*.env` read-only and never `*.key`. Daemon unit tests get an empty temp one from `apps/daemon/test/setup-env.ts` (a vitest `setupFiles` entry); `makeTempHomes().env` carries one for a daemon started on those homes.
- **`ORC_PORT`** overrides `OrcConfig.port` for one run (`apps/daemon/src/main.ts`).
- **`ORC_NOTIFY=off`** (P2) registers no notification channel at all, so nothing is sent on any channel. The unit tests and the e2e run set it.
- **`ORC_NOTIFY_BRIDGE=stdout`** (P7, set by the Tauri shell) replaces the node-notifier `macos` channel with `createStdoutNotifyChannel()` (`notify/stdout-bridge.ts`). It keeps the channel id `macos`, so notification preferences route to it unchanged, and prints one line per notification: `ORC_NOTIFY ` + JSON `{ title, body, url, kind }` (`body` is `redact(item.reason)`, at most 240 chars). `ORC_NOTIFY=off` still wins.
- **`ORC_WEB_DIR`** (P7, set by the Tauri shell to its bundled `resources/web`) overrides the static web root; it wins over the repo's `apps/web/dist` (`main.ts`).
- **`orc-mcp`** reads `ORC_URL`, then `ORC_PORT`, then `port` from `$ORC_HOME/config.json`, then `4317`; the token is `ORC_TOKEN` or `$ORC_HOME/token` (read-only). `ORC_HOME` defaults to `~/.orchestrator`.

```
$ORC_HOME/
  config.json        # user config (zod-validated, see OrcConfig)
  index.db           # SQLite (mode 0600)
  token              # per-install API token (mode 0600), 32 random bytes hex
  archive/<projectId>/<sessionId>.jsonl.zst
  archive/<projectId>/<sessionId>/subagents/agent-<id>.jsonl.zst
  logs/daemon.log
  vapid.json         # phase 6: { publicKey, privateKey, createdAt } (created on first boot, mode 0600)
```

```ts
// apps/daemon/src/config.ts
export interface OrcPaths { orcHome: string; claudeHome: string; codexHome: string; dbFile: string; tokenFile: string; archiveDir: string; logFile: string }
export function resolvePaths(env?: NodeJS.ProcessEnv): OrcPaths
export function loadConfig(paths: OrcPaths): OrcConfig   // creates defaults if missing
export function saveConfig(paths: OrcPaths, cfg: OrcConfig): void

// packages/api-contract/src/config.ts  (zod)
export const ProjectConfig = z.object({
  id: z.string(),                          // slug, e.g. "wakecap"
  name: z.string(),
  pathPrefixes: z.array(z.string()),       // absolute paths
  hidden: z.boolean().default(false),
  openIn: z.enum(['vscode', 'terminal', 'finder']).default('vscode'),
  ticketRegex: z.string().nullable().default(null),       // e.g. "\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b"
  prodPatterns: z.array(z.string()).default([]),
  features: z.object({ workStreams: z.boolean().default(false), prodBadges: z.boolean().default(false), recaps: z.boolean().default(true) }).prefault({}),
  repos: z.array(z.object({ path: z.string(), setup: z.string().optional(), run: z.string().optional(), archive: z.string().optional(), copyGlobs: z.array(z.string()).default([]), worktreeDir: z.string().default('.worktrees') })).default([]),
  budgets: z.object({ dailyUsd: z.number().optional(), weeklyUsd: z.number().optional(), monthlyUsd: z.number().optional() }).prefault({}),
  maxConcurrentOwned: z.number().int().positive().default(6),
});
export const OrcConfig = z.object({
  port: z.number().int().default(4317),
  defaultProjectId: z.string().default('wakecap'),
  resumeProfile: z.object({ claudeCommand: z.string().default('claude'), claudeArgs: z.array(z.string()).default(['--dangerously-skip-permissions']), codexCommand: z.string().default('codex'), codexArgs: z.array(z.string()).default([]) }).prefault({}),
  projects: z.array(ProjectConfig).default([]),
  codex: z.object({ showAutomated: z.boolean().default(false) }).prefault({}),
  recaps: RecapsConfig.prefault({}),                                                                  // P5: named schema, see below
  notifications: z.record(z.string(), z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) })).default({}),
  archive: z.object({ enabled: z.boolean().default(true), maxGb: z.number().default(10) }).prefault({}),
  live: z.object({ pollMs: z.number().int().positive().default(1000), endedRetentionMin: z.number().int().positive().default(10), codexBusyWindowMs: z.number().int().positive().default(10000) }).prefault({}),   // P2
  safety: z.object({                                                                                   // P3
    extraDenyPatterns: z.array(z.string()).default([]),
    prodSkills: z.array(z.string()).default(['production_server_db', 'production_server_logs', 'wecare_production_db']),
    secretScanPaths: z.array(z.string()).default(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']),
  }).prefault({}),
  links: z.object({                                                                                    // P3
    linearWorkspace: z.string().nullable().default(null),
    planRoots: z.array(z.string()).default(['~/Wakecap/plans']),
  }).prefault({}),
  github: z.object({                                                                                   // P4
    enabled: z.boolean().default(true),                    // false → wirePhase4 never starts the PR poller
    pollSeconds: z.number().int().min(30).default(90),
    ticketUrlTemplate: z.string().default('https://linear.app/wakecap/issue/{ticket}'),   // used in PR bodies
    protectedBranches: z.array(z.string()).default(['main', 'master', 'develop', 'staging', 'testing', 'production']),
  }).prefault({}),
  worktrees: z.object({                                                                                // P4
    autoArchiveOnMerge: z.boolean().default(true),
    scratchpadRoots: z.array(z.string()).default(['/private/tmp']),   // scans <root>/claude-*/… up to depth 6
    scanSiblings: z.boolean().default(true),
    implementTicketMode: z.enum(['precreate', 'conductor']).default('conductor'),
    checkpointsPerSession: z.number().int().positive().default(200),
  }).prefault({}),
  limits: LimitsConfig.prefault({}),                                                                   // P5
  digest: DigestConfig.prefault({}),                                                                   // P5
  hooks: HooksConfig.prefault({}),                                                                     // P5
  remote: RemoteConfig.prefault({}),                                                                   // P6
  away: AwayConfig.prefault({}),                                                                       // P6
  connectors: ConnectorsConfig.prefault({}),                                                           // P6
  automations: z.object({ … }).prefault({}),                                                           // P7, see below
  supervisor: z.object({ … }).prefault({}),                                                            // P7
  compare: z.object({ maxVariants: z.number().int().min(2).max(6).default(4) }).prefault({}),          // P7
  agnc: z.object({ … }).prefault({}),                                                                  // P7
}).strict();
export type OrcConfig = z.infer<typeof OrcConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;

// P5 sections (as built, packages/api-contract/src/config.ts)
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
  idleMinutes: z.number().int().positive().default(10),        // on_idle debounce
  excludeProjectIds: z.array(z.string()).default([]),
  dailyProjectIds: z.array(z.string()).default(['wakecap']),   // daily recap targets
});
export const LimitsConfig = z.object({
  quotaSource: z.enum(['estimate', 'official']).default('official'),   // spike S7 (§14)
  officialFieldPaths: z.object({
    blockPct: z.string().nullable().default('rate_limits.five_hour.used_percentage'),
    blockResetsAt: z.string().nullable().default('rate_limits.five_hour.resets_at'),
    weekPct: z.string().nullable().default('rate_limits.seven_day.used_percentage'),
    weekResetsAt: z.string().nullable().default('rate_limits.seven_day.resets_at'),
  }).prefault({}),
  blockTokenLimit: z.number().int().positive().nullable().default(null),   // user plan limit (5h)
  weekTokenLimit: z.number().int().positive().nullable().default(null),    // user plan limit (7d)
  warnPct: z.number().min(0).max(1).default(0.8),
  contextWindows: z.record(z.string(), z.number().int().positive())
    .default({ 'claude-opus-5': 1000000, 'claude-sonnet-5': 1000000, 'claude-haiku-4-5': 200000 }),
  defaultContextWindow: z.number().int().positive().default(200000),
  // USD per 1M tokens (list prices checked 2026-09-17; cache write = 1.25 × input, cache read = 0.1 × input). Estimates only.
  pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number(), cacheWrite: z.number(), cacheRead: z.number() }))
    .default({
      'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    }),
  contextWarnFill: z.number().min(0).max(1).default(0.85),
});
export const DigestConfig = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().default('0 9 * * 1'),               // weekly digest, Mon 09:00 local
  dailyRecapCron: z.string().default('0 19 * * 1-5'),  // daily project recap
});
export const HooksConfig = z.object({ statusOverrideMs: z.number().int().positive().default(120000) });
export type RecapsConfig = z.infer<typeof RecapsConfig>;   // and LimitsConfig, DigestConfig, HooksConfig

// P6 sections (as built, packages/api-contract/src/config.ts)
export const RemoteConfig = z.object({
  enabled: z.boolean().default(false),
  origin: z.string().nullable().default(null),            // e.g. "https://mac.tail1234.ts.net" (no trailing slash); also the passkey rpID host
  allowedLogin: z.string().nullable().default(null),      // Tailscale-User-Login that may use the app remotely (trimmed; blank = remote off)
  stepUpTtlSec: z.number().int().positive().default(300),
  pairingTtlSec: z.number().int().positive().default(300),
});
export const AwayConfig = z.object({
  auto: z.boolean().default(true),                        // follow macOS idle time (ioreg HIDIdleTime)
  idleMinutes: z.number().int().positive().default(10),
  channels: z.array(z.enum(['webpush', 'slack_dm'])).default(['webpush', 'slack_dm']),
});
export const ConnectorsConfig = z.object({
  linear: z.object({
    enabled: z.boolean().default(true),
    defaultTeamKey: z.string().nullable().default(null),
    pollSeconds: z.number().int().min(30).default(120),
    redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/linear/callback'),   // unused: no Linear OAuth (P6 Task 21 skipped)
  }).prefault({}),
  slack: z.object({
    enabled: z.boolean().default(true),
    redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/slack/callback'),
    dailyChannel: z.string().nullable().default(null),
    pollSeconds: z.number().int().min(30).default(60),
    dmBridge: z.boolean().default(true),
    bridgePollSeconds: z.number().int().min(5).default(15),
    nudgeViaReminder: z.boolean().default(false),         // spike S9 g2/g4 decide this; unconfirmed
  }).prefault({}),
});
export type RemoteConfig = z.infer<typeof RemoteConfig>;   // and AwayConfig, ConnectorsConfig

// P7 sections (as built, inline in OrcConfig, packages/api-contract/src/config.ts). Every switch is off by default.
automations: z.object({
  enabled: z.boolean().default(false),                    // master switch: cron schedules and event triggers attach only while on
  maxConcurrent: z.number().int().positive().default(2),
  suggestions: z.object({ enabled: z.boolean().default(false), intervalMin: z.number().int().positive().default(60) }).prefault({}),
}).prefault({}),
supervisor: z.object({
  enabled: z.boolean().default(false),                    // master switch; per-session / per-project targets live in supervisor_targets
  model: z.string().default('claude-haiku-4-5'),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
  maxPerSessionPerHour: z.number().int().nonnegative().default(3),
  maxPerHour: z.number().int().nonnegative().default(10),
  monthlyBudgetUsd: z.number().nonnegative().default(5),
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullable().default(null),
  debounceMs: z.number().int().nonnegative().default(3000),
}).prefault({}),
compare: z.object({ maxVariants: z.number().int().min(2).max(6).default(4) }).prefault({}),   // no switch: runs only when the user launches a comparison
agnc: z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('https://agnc.wakecap.ai/mcp'),
  pollSeconds: z.number().int().positive().default(30),
}).prefault({}),
```


> **zod 4 note (found in Phase 0, Task 4):** `.default({})` on a nested object does **not** recurse into that object's own field defaults — it short-circuits after the parse. Use **`.prefault({})`** for every nested object that must fill its inner defaults. All nested plain-object fields above use `.prefault({})` for this reason; leaf fields keep `.default(...)`, and `z.record`/`z.array` fields keep `.default([])`/`.default({})` (they have no inner field defaults to fill).
`safety` and `links` (P3) and `github` and `worktrees` (P4) use `.prefault({})`, not the `.default({})` of their plan text, for the zod 4 reason above. The daemon test homes (`apps/daemon/test/helpers.ts`) and the e2e server (`apps/daemon/test/e2e-server.ts`) write `github: { enabled: false }`, so no test daemon polls `gh`. `recaps`, `limits`, `digest` and `hooks` (P5) and `remote`, `away` and `connectors` (P6) and `automations`, `supervisor`, `compare` and `agnc` (P7) also use `.prefault({})`; recaps stay `enabled: false` in every test daemon. The fixture e2e server roots its homes at `ORC_E2E_ROOT` (one `mkdtemp` per Playwright run, set by `apps/web/playwright.config.ts` together with `ORC_E2E_WORK`), or its own `mkdtemp` root when started by hand. `safety.secretScanPaths` is expanded against the real home directory, not `ORC_USER_HOME`, so a daemon on fixture homes still scans the real `~/Wakecap` files.

When no projects are configured, the defaults come from Phase 1 auto-detection. The `wakecap` project gets `pathPrefixes: ["/Users/hazem/Wakecap"]`, the ticket regex above, `prodPatterns` from F9, and `features.workStreams = features.prodBadges = true`.

## 4. Domain types (`@orc/core/src/types`)

```ts
export type Source = 'claude' | 'codex' | 'agnc';
export type Availability = 'resumable' | 'archived' | 'prompts-only' | 'remote';
export type LiveStatus = 'busy' | 'idle' | 'waiting' | 'shell' | 'review' | 'blocked' | 'error' | 'ended';
export type Stage = 'understand' | 'modify' | 'test' | 'review';
export type Ownership = 'observed' | 'owned';

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });

export interface PrRef { repo: string; number: number; url: string }

export interface TestResult { ts: string; command: string; passed: number; failed: number; skipped: number; durationMs: number | null }

export interface Session {
  id: string;                    // source-native id (Claude sessionId / Codex session id / AGNC id)
  source: Source;
  projectId: string | null;      // resolved via project path prefixes
  startCwd: string;              // resume dir
  cwds: string[];                // distinct cwds in first-seen order (startCwd first)
  name: string | null;           // agent-name → ai-title → first prompt (truncated 80)
  firstPrompt: string | null;
  lastPrompt: string | null;
  awaySummary: string | null;
  recap: string | null;          // LLM recap (F14)
  startedAt: string;             // ISO
  lastActivityAt: string;        // ISO
  models: string[];              // excludes '<synthetic>'
  permissionMode: string | null;
  usage: Usage;
  linesAdded: number | null;
  linesRemoved: number | null;
  prs: PrRef[];
  tickets: string[];
  skills: string[];
  mcpServers: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  flags: { touchedProd: boolean; hasSubagents: boolean; automated: boolean };
  availability: Availability;
  transcriptPath: string | null;
  lastTest: TestResult | null;
  live: LiveState | null;
}

export interface LiveState {
  pid: number | null;
  status: LiveStatus;
  waitingFor: string | null;
  since: string;                 // ISO, when status last changed
  ownership: Ownership;
  ptyId: string | null;          // set when owned
  stage: Stage | null;
  currentTool: string | null;
  backgroundJobs: number;
  runningSubagents: number;
  contextFill: number | null;    // 0..1
}

export interface AgentNode {
  id: string;                    // agentId
  sessionId: string;
  parentId: string | null;       // parent agentId, null = main session
  depth: number;
  agentType: string;
  description: string;
  background: boolean;
  toolUseId: string | null;
  usage: Usage;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'error';
  transcriptPath: string;
}

export type EventKind = 'prompt' | 'assistant_text' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'error';
export interface TimelineEvent {
  sessionId: string;
  agentId: string | null;
  uuid: string;
  parentUuid: string | null;
  seq: number;                   // monotonically increasing per file
  ts: string;
  kind: EventKind;
  turn: number;                  // increments at each human prompt
  text: string | null;           // redacted at display time, stored raw
  tool: string | null;           // e.g. 'Bash', 'mcp__claude_ai_Linear__save_issue'; for kind:'system' events
                                  // synthesized from `command`/`compact_summary` Claude records, `tool` is
                                  // the literal string 'command' or 'compact_summary' (P1, Task 2 ruling —
                                  // these are NOT human prompts: they never increment promptCount and never
                                  // seed firstPrompt/lastPrompt/name, but they render distinctly in the
                                  // timeline via this tool value)
  toolUseId: string | null;
  mcpServer: string | null;
  input: unknown | null;         // tool_use input (JSON)
  messageId: string | null;      // assistant message.id for usage dedupe
  model: string | null;
  usage: Usage | null;           // only on the first record per messageId
  durationMs: number | null;     // system turn_duration
}

export interface Project { id: string; name: string; pathPrefixes: string[]; hidden: boolean; lastActivityAt: string | null; sessionCount: number }

export type InboxKind = 'waiting' | 'review' | 'plan_approval' | 'blocked' | 'error' | 'tests_red' | 'budget' | 'automation_result' | 'supervisor_escalation' | 'pr_event' | 'reminder';
export type InboxState = 'open' | 'snoozed' | 'done' | 'auto_resolved';
export interface InboxItem { id: string; kind: InboxKind; sessionId: string | null; projectId: string | null; ticket: string | null; reason: string; dedupeKey: string; createdAt: string; updatedAt: string; state: InboxState; snoozeUntil: string | null; payload: Record<string, unknown> }

export type GoalState = 'active' | 'paused' | 'blocked' | 'complete';
export interface Goal { id: string; targetType: 'session' | 'stream'; targetId: string; objective: string; state: GoalState; blockedReason: string | null; updatedAt: string }
export interface Handoff { id: string; sessionId: string; status: string; summary: string; evidence: string[]; files: string[]; nextSteps: string[]; blockers: string[]; links: string[]; createdAt: string }

export interface Worktree { path: string; repo: string; branch: string; base: string | null; ticket: string | null; dirty: boolean; prUrl: string | null; state: 'active' | 'archived'; createdByApp: boolean }
export interface Checkpoint { id: string; sessionId: string; worktreePath: string; turn: number; ref: string; commit: string; createdAt: string }

export type StreamStage = 'planned' | 'implementing' | 'in_review' | 'pr_open' | 'merged' | 'backmerged' | 'released';
export interface WorkStream { ticket: string; projectId: string; title: string | null; stage: StreamStage; sessionIds: string[]; prs: PrRef[]; plans: string[]; worktrees: string[]; costUsd: number; lastActivityAt: string }

export type AuditActor = 'user' | 'automation' | 'supervisor' | 'remote';
export interface AuditEntry { id: string; ts: string; actor: AuditActor; actorDetail: string | null; action: string; target: string | null; params: Record<string, unknown>; result: 'ok' | 'error' | 'denied'; error: string | null }
```

**P2 derivations (`@orc/core`)** — pure, no `node:fs`, all re-exported from `src/index.ts`:

```ts
// claude/registry.ts
export type RegistryStatus = 'busy' | 'idle' | 'waiting' | 'shell';
export interface RegistryEntry { pid: number; procStart: string | null; sessionId: string; cwd: string; startedAt: number | null; version: string | null; kind: string | null; name: string | null; status: RegistryStatus | null; waitingFor: string | null; statusUpdatedAt: number | null; updatedAt: number | null }
export function parseRegistryEntry(value: unknown): RegistryEntry | null;   // never throws; never copies messagingSocketPath or any peer* field
export const parseRegistryFile = parseRegistryEntry;                        // P1 alias, kept
export function isRegistryFileName(name: string): boolean;                  // /^\d+\.json$/ — never matches *.key
export function registryStatusToLive(status: string): LiveStatus;
// derive/tests.ts
export function isTestCommand(command: string): boolean;
export function parseTestOutput(command: string, output: string, ts: string): TestResult | null;
// derive/stage.ts
export type ToolCategory = 'read' | 'edit' | 'test' | 'other';
export function categorizeTool(tool: string, input: unknown): ToolCategory;
export function inferStage(s: { categories: ToolCategory[]; turnEnded: boolean; changedFiles: number }): Stage | null;
// derive/live-transcript.ts
export interface TranscriptLive { turn: number; lastPrompt: string | null; currentTool: string | null; stage: Stage | null; backgroundJobs: number; runningSubagents: number; contextFill: number | null; lastTest: TestResult | null; turnEnded: boolean; turnChangedFiles: string[]; turnPrs: number; lastApiError: string | null; permissionMode: string | null; lastActivityAt: string | null }
export interface LiveReducerEffects { testRecorded: TestResult | null; turnEnded: number | null }
export interface LiveReducer { apply(value: unknown): LiveReducerEffects; snapshot(): TranscriptLive }
export const emptyTranscriptLive: () => TranscriptLive;
export function createLiveReducer(opts?: { contextWindow?: number }): LiveReducer;
// derive/live-status.ts
export interface DeriveStatusInput { alive: boolean; registryStatus: RegistryStatus | null; transcript: TranscriptLive }
export function deriveLiveStatus(i: DeriveStatusInput): LiveStatus;
export function splitPk(pk: string): { source: Source; id: string };
```

`deriveLiveStatus` precedence: `ended` (process dead) > `waiting`/`busy`/`shell` (straight from the registry) > `error` (last assistant record was an API error) > `review` (turn ended having changed a file or opened a PR) > `idle`. `blocked` needs Phase-5 goal data and never comes out of this function yet.

**Derived (Phase 3, `@orc/core/src/derive/*`)** — pure, exported from both `src/index.ts` and `src/browser.ts`:

```ts
// derive/step-stats.ts
export interface TurnStats { turn: number; agentId: string | null; startedAt: string; endedAt: string; wallMs: number; modelMs: number; toolMs: number; reportedMs: number | null; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
export interface SessionStats { turns: number; wallMs: number; modelMs: number; toolMs: number; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
export function computeTurnStats(events: readonly TimelineEvent[]): TurnStats[]
export function computeSessionStats(turns: readonly TurnStats[]): SessionStats
export function cacheHitRate(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | null   // cacheRead / (input + cacheRead + cacheWrite)
export function median(xs: readonly number[]): number | null

// derive/deliverables.ts
export type DeliverableStatus = 'applied' | 'failed' | 'pending';
export interface FileChange { path: string; tool: string; toolUseId: string | null; turn: number; seq: number; ts: string; agentId: string | null; status: DeliverableStatus; oldText: string | null; newText: string | null }
export interface DeliverableFile { path: string; tools: string[]; ops: number; status: DeliverableStatus; lastTs: string }
export interface TurnDeliverables { turn: number; agentId: string | null; files: DeliverableFile[] }
export interface FileSummary { path: string; ops: number; failedOps: number; turns: number[]; agentIds: Array<string | null>; firstTs: string; lastTs: string; changes: FileChange[] }
export const FILE_EDIT_TOOLS: readonly ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']
export function extractFileChanges(events: readonly TimelineEvent[]): FileChange[]
export function deliverablesByTurn(events: readonly TimelineEvent[]): TurnDeliverables[]
export function summarizeFiles(changes: readonly FileChange[]): FileSummary[]

// derive/prod-detect.ts  (command patterns reuse the Phase 1 DEFAULT_PROD_PATTERNS from derive/prod.ts)
export const DEFAULT_PROD_SKILLS: readonly string[]      // production_server_db, production_server_logs, wecare_production_db
export interface ProdTouch { seq: number; ts: string; agentId: string | null; kind: 'skill' | 'command'; tool: string; detail: string }  // detail is redacted
export function detectProdTouches(events: readonly TimelineEvent[], opts?: { prodSkills?: readonly string[]; prodPatterns?: readonly string[] }): ProdTouch[]
// derive/permission.ts
export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | 'unknown';
export function permissionBadge(modes: readonly (string | null | undefined)[]): PermissionBadge
// derive/patterns.ts
export function compilePattern(pattern: string): RegExp  // case-insensitive; invalid regex → escaped literal
// derive/secret-scan.ts
export interface SecretFinding { line: number; kind: string }
export function scanTextForSecrets(text: string): SecretFinding[]
// derive/deny-list.ts — DenyVerdict, checkDenied, DEFAULT_DENY_PATTERNS (§11 names, unchanged)
```

**P4 domain types** (`packages/core/src/types/work.ts`):

```ts
export type WorktreeOrigin = 'app' | 'config' | 'session-cwd' | 'claude-json' | 'worktree-dir' | 'sibling' | 'scratchpad';
export interface WorktreeView extends Worktree { head: string | null; isMain: boolean; origin: WorktreeOrigin; sessionPks: string[]; projectId: string | null; prStatus: PrStatus | null; updatedAt: string }
export interface PrStatus { pr: PrRef; state: 'open' | 'closed' | 'merged'; title: string; checks: 'pending' | 'success' | 'failure' | 'none'; review: 'approved' | 'changes_requested' | 'review_required' | 'none'; updatedAt: string; headRef: string | null; failedChecks: string[] }
export interface DiffHunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface DiffFileEntry { path: string; oldPath: string | null; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'; additions: number; deletions: number; patch: string; hunks: DiffHunk[] }
export interface DiffResult { cwd: string; from: string; to: string; files: DiffFileEntry[]; additions: number; deletions: number }
export interface ReviewComment { file: string; line: number; side: 'old' | 'new'; body: string }
export interface ReviewSummary { sessionPk: string; cwd: string; worktree: WorktreeView | null; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number; lastTest: TestResult | null; recap: string | null; pr: PrStatus | null; owned: boolean; checkpoints: CheckpointRecord[] }
export interface CheckpointRecord extends Checkpoint { kind: 'turn' | 'safety' | 'manual' }
```
`PrStatus` lives in core types (it supersedes the §11 draft by adding `headRef` and `failedChecks`); `connectors/github/github.ts` re-exports it.

**P4 core git helpers** (`packages/core/src/git/index.ts`, pure): `branchName`, `ticketFromBranch`, `worktreeDirName`, `BranchType`, `parseUnifiedDiff`, `hunkPatch`, `buildReviewPrompt`, and everything in `status-porcelain.ts` and `worktree-porcelain.ts`. `branch.ts` declares its own `slugify` and `DEFAULT_TICKET_REGEX`; because `derive/` already exports both names, the barrel re-exports them as **`branchSlug`** and **`DEFAULT_BRANCH_TICKET_REGEX`**.

**P5 domain types** (`packages/core/src/types/{usage,streams,recaps,bridge,analytics}.ts`, as built):
```ts
export type UsageSource = 'official' | 'estimate';
export interface UsageSnapshot {            // pctOfLimit is a fraction (0..1, may exceed 1)
  source: UsageSource; generatedAt: string;
  block: { active: boolean; start: string; end: string; tokens: number; costUsd: number; pctOfLimit: number | null };
  week: { tokens: number; costUsd: number; pctOfLimit: number | null };
  burnRateUsdPerHour: number; burnRateTokensPerMin: number; projectedBlockExhaustionAt: string | null;
}
export interface OfficialQuotaSample { at: string; blockPct: number | null; blockResetsAt: string | null; weekPct: number | null; weekResetsAt: string | null }
export type BudgetScopeType = 'global' | 'project' | 'ticket';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';
export interface Budget { id: string; scopeType: BudgetScopeType; scopeId: string | null; period: BudgetPeriod; limitUsd: number; origin: 'table' | 'config' }
export interface BudgetStatus { budget: Budget; spentUsd: number; pct: number; periodStart: string }
export interface BudgetCheck { ok: boolean; pct: number; limitUsd: number | null }
export interface ConcurrencyStatus { projectId: string; owned: number; max: number }
export interface ContextFillInfo { sessionPk: string; model: string | null; usedTokens: number; windowTokens: number; fill: number; warn: boolean }
export type StreamLinkKind = 'session' | 'pr' | 'plan' | 'worktree' | 'workflow';
export interface StreamLink { ticket: string; kind: StreamLinkKind; ref: string; origin: 'auto' | 'manual'; excluded: boolean; createdAt: string }
export type TicketSignalSource = 'session_tickets' | 'prompt' | 'branch' | 'pr_title' | 'pr_body' | 'plan_file' | 'wstack_workflow' | 'worktree' | 'manual';
export interface TicketSignal { ticket: string; kind: StreamLinkKind; ref: string; source: TicketSignalSource }
export interface StreamPr { pr: PrRef; title: string; state: 'open' | 'closed' | 'merged'; headRef: string | null; baseRef: string | null; isBackmerge: boolean; checks: 'pending' | 'success' | 'failure' | 'none'; review: 'approved' | 'changes_requested' | 'review_required' | 'none'; updatedAt: string; mergedAt: string | null }
export type StreamTimelineKind = 'session' | 'pr' | 'plan' | 'worktree' | 'recap' | 'handoff' | 'goal' | 'workflow';
export interface StreamTimelineItem { ts: string; kind: StreamTimelineKind; title: string; ref: string; detail: string | null }
export interface StreamDetail { stream: WorkStream; prsDetailed: StreamPr[]; links: StreamLink[]; timeline: StreamTimelineItem[]; goal: Goal | null; handoff: Handoff | null; budget: BudgetCheck }
export type RecapKind = 'session' | 'daily' | 'handoff';
export type RecapEngineId = 'claude-cli' | 'anthropic-api';
export interface Recap { id: string; kind: RecapKind; targetKey: string; transcriptOffset: number; model: string; engine: RecapEngineId; text: string; costUsd: number; inputTokensApprox: number; createdAt: string }
export type ReminderState = 'pending' | 'fired' | 'cancelled';
export interface Reminder { id: string; jobId: string; sessionPk: string | null; ticket: string | null; text: string; dueAt: string; sendToSession: boolean; state: ReminderState; createdAt: string; firedAt: string | null }
export interface DigestRecord { weekStart: string; markdown: string; createdAt: string }
export type HookEventName = 'SessionStart' | 'Stop' | 'Notification' | 'PreToolUse' | 'PostToolUse';
export interface HookFields { sessionId: string; event: string; message: string | null; tool: string | null }   // the only fields kept from a hook payload
export interface HookSignal { sessionId: string; event: string; status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null; currentTool: string | null }
export type AnalyticsGroupBy = 'day' | 'week' | 'project' | 'model' | 'source' | 'ticket';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostRow { key: string; costUsd: number; tokens: TokenTotals; sessions: number }
export interface TopSession { pk: string; name: string | null; projectId: string | null; costUsd: number; tickets: string[] }
export interface TopTicket { ticket: string; costUsd: number; sessions: number }
export interface TopResult { sessions: TopSession[]; tickets: TopTicket[]; mergedPrs: number; costPerMergedPrUsd: number | null }
export type ToolKind = 'tool' | 'mcp' | 'skill';
export interface ToolUsageRow { bucket: string; kind: ToolKind; name: string; count: number }
export interface TimingResult { modelMs: number; toolMs: number; modelShare: number | null; cacheHitTrend: Array<{ bucket: string; rate: number | null }> }
export interface OutcomesResult { sessions: number; outcomes: Record<string, number>; friction: Record<string, number>; goalCategories: Record<string, number> }
export interface WstackSkillRow { skill: string; runs: number; outcomes: Record<string, number>; avgDurationS: number | null }
// Handoff.sessionId holds the session pk (`source:id`).
```

**P5 core helpers** (pure, exported from `@orc/core`):
- `derive/quota.ts`: `buildBlocks`, `activeBlock`, `windowTotals`, `burnRate`, `projectExhaustion`, `projectFromPct`, `computeUsageSnapshot`, `contextWindowFor`, `contextFill`, `readPath`, `mapOfficialQuota`, `BLOCK_MS`, `WEEK_MS`, `OFFICIAL_MAX_AGE_MS`.
- `derive/pricing.ts`: `PriceTable`, `estimateCostUsd(model, usage, prices): number | null`.
- `derive/ledger.ts`: `extractLedgerFacts` (`LedgerUsageFact`, `LedgerToolFact`).
- `derive/streams.ts`: `collectTicketSignals`, `applyManualLinks`, `groupSignals`, `computeStreamStage`, `isBackmergePr`, `planTicket`, `parseWstackEnv`, `extractTicketsFrom`, `prTickets`, `STREAM_STAGES`, `REVIEW_SKILLS`, `RELEASE_SKILLS`, `STREAM_TICKET_PATTERN`.
- `derive/analytics.ts`: `bucketKey`, `groupCost`, `topSessionCosts`, `topTickets`, `costPerMergedPr`, `toolUsageRows`, `timingSummary`, `summarizeFacets`, `summarizeWstackTimeline`; `derive/digest.ts`: `renderWeeklyDigest`.
- `derive/hooks.ts`: `pickHookFields`, `hookStatusFor`, `mapHookPayload`, `hookWins`, `BRIDGE_HOOK_EVENTS` (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop), `HOOK_BODY_LIMIT_BYTES` (256 KiB).
- `recap/digest.ts`: `buildRecapDigest`, `renderPromptTemplate`, `DEFAULT_RECAP_PROMPT`, `DEFAULT_DAILY_PROMPT`, `DEFAULT_HANDOFF_PROMPT`, `approxTokens`, `truncateText`, `firstLine`; `recap/handoff.ts`: `collectHandoffEvidence`, `parseHandoffJson`, `handoffToMarkdown`, `buildResumePrompt`.
- `derive/live-transcript.ts`: `createLiveReducer` takes `opts.windows: { table, defaultWindow }` and scales context fill with `contextFill`, keeping the widest window a session has needed.

**Audit action names** use a `<area>.<verb>` form: `session.launch`, `session.resume`, `session.fork`, `session.kill`, `session.export` (P3), `session.open` (P3, `POST …/open-in`), `pty.input`, `archive.restore`, `archive.sync` (P3), `worktree.create`, `worktree.sync`, `worktree.archive`, `checkpoint.create`, `checkpoint.rewind`, `git.commit`, `git.push`, `pr.create`, `pr.merge`, `automation.run`, `supervisor.answer`, `linear.comment`, `slack.post`, `remote.approve`, `hook.install`, and from P4 `worktree.script`, `worktree.open`, `worktree.prune`, `git.revert`, `review.send`, `plan.approve`, `plan.reject`, `ship.backmerge` (`worktree.prune` is reserved: nothing records it yet). The PR-merge auto-archive records `worktree.archive` with actor `automation`. P5: `POST /api/handoffs/:id/resume-fresh` records `session.launch` (target `handoff:<id>`), and `POST /api/hooks/install` records `hook.install` (target `claude-settings`). P6 adds `connector.connect`, `connector.configure`, `connector.disconnect`, `linear.issue.create`, `inbox.approve`, `remote.configure`, `remote.pairing_code`, `remote.pair`, `remote.revoke`, `webauthn.register` and `away.set`, and is the first phase to record `linear.comment`, `slack.post` and `remote.approve`; remote replies record `pty.input` with actor `remote` and `actorDetail` `"<device> (<login>)"` or `slack_dm`. Connector and share entries never carry a token, a client secret or the full post body (a redacted preview of at most 300 chars). P7 adds `automation.approve`, `automation.reject`, `compare.launch`, `compare.pick`, `compare.archive`, `supervisor.escalate`, `supervisor.feedback`, `supervisor.rule`, `agnc.connect`, `agnc.disconnect`, `agnc.prompt`, `agnc.create` and `settings.update`, and is the first phase to record `automation.run` (actor `automation` for cron/event/rerun runs) and `supervisor.answer` (actor `supervisor`, `actorDetail` = the classifier model). `settings.update` covers automation create/save/enable/delete, `PATCH …/automations/settings`, `PATCH …/supervisor/settings` and `PUT …/supervisor/targets`. Accepting a suggestion records `session.launch`; archiving compare losers also records `session.kill` for each running loser. Supervisor answers are sent inside `actorScope.run({ actor: 'supervisor', actorDetail: model }, …)`, so their `pty.input` entry carries that actor. The AGNC prompt text is never in an audit entry (`omitParams: ['prompt']`). `supervisor.evaluate` names the `POST /api/supervisor/evaluate/:source/:id` route in `AUDITED_ROUTES`; the service itself records `supervisor.answer` or `supervisor.escalate` (nothing on a dry run), and the middleware records `supervisor.evaluate` only for a request that fails first.

## 5. SQLite & migrations

- **Stack:** Drizzle ORM (`drizzle-orm/better-sqlite3`). The schema lives in `apps/daemon/src/db/schema.ts`. Migrations are generated with `pnpm --filter @orc/daemon db:generate` into `apps/daemon/src/db/migrations/` and run at boot with `migrate()`.
- **Pragmas at boot:** `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`. `chmod 0600` is applied to the db file.
- **Naming:**
  - tables are `snake_case` plurals
  - columns are `snake_case`
  - timestamps are ISO text, with `_at` columns
  - JSON goes in `text` columns with the `_json` suffix
  - booleans are `integer` with `{ mode: 'boolean' }`
- **Tables** (the phase that introduces each one owns its definition):

| Table | Phase | Key |
|---|---|---|
| `projects` | 1 | `id` |
| `sessions` | 1 | `(source, id)` → column `pk` = `${source}:${id}` |
| `events` + `events_fts` (FTS5, external content) | 1 | `(session_pk, agent_id, seq)` |
| `agents` | 1 | `(session_pk, id)` |
| `file_offsets` | 1 | `path` |
| `history_prompts` | 1 | `(session_id, ts)` |
| `labels`, `pins`, `saved_views` | 1 | — |
| `pty_sessions` | 1 | `id` |
| `inbox_items` | 2 | `id`, unique `dedupe_key` where state in (open, snoozed) |
| `archive_entries` | 2 | `path` |
| `test_results` | 2 | `(session_pk, ts)` |
| `audit_log` | 3 | `id` |
| `worktrees` | 4 | `path` |
| `checkpoints` | 4 | `id`; unique `ref` |
| `pr_cache` | 4 | `key` = `${repo}#${number}` |
| `streams`, `stream_links`, `recaps`, `goals`, `handoffs`, `reminders`, `budgets`, `usage_blocks`, `scheduled_jobs`, `usage_entries`, `tool_uses`, `ledger_cursors`, `digests` | 5 | migration `0008_phase5.sql`; Drizzle tables in `apps/daemon/src/db/schema-p5.ts`, repos in `db/repos/{budgets,digests,goals,handoffs,recaps,reminders,scheduled-jobs,streams,usage-ledger}.ts` |
| `connector_tokens_meta` | 6 | `connector` (`linear` \| `slack`) — migration `0009_phase6.sql`; Drizzle tables in `apps/daemon/src/db/schema-p6.ts` |
| `remote_devices` | 6 | `id`; unique `token_hash` (sha256 of the device token) |
| `webauthn_credentials` | 6 | `id` (credential id, base64url); `device_id` → `remote_devices.id` (cascade) |
| `push_subscriptions` | 6 | `id`; unique `endpoint`; `device_id` nullable → `remote_devices.id` (cascade) |
| `slack_threads` | 6 | `inbox_item_id` |
| `automations` | 7 | `id` — migration `0010_phase7_automations.sql` |
| `automation_runs` | 7 | `id`; unique (`automation_id`, `trigger_key`) — one run per trigger key |
| `automation_suggestions` | 7 | `id`; unique `dedupe_key` |
| `compare_groups` | 7 | `id` — migration `0011_phase7_compare.sql` |
| `supervisor_rules`, `supervisor_decisions` | 7 | `id` — migration `0012_phase7_supervisor.sql` |
| `supervisor_targets` | 7 | (`target_type`, `target_id`) |

- **P2 columns** (as built, `apps/daemon/src/db/schema.ts`):

| Table | Columns |
|---|---|
| `inbox_items` | `id` text pk, `kind`, `session_id`, `project_id`, `ticket`, `reason`, `dedupe_key`, `created_at`, `updated_at`, `state`, `snooze_until`, `payload_json` (not null, default `'{}'`). Unique index `inbox_items_active_dedupe` on `dedupe_key` `WHERE state in ('open','snoozed')`. Index `inbox_items_state_idx` (`state`, `updated_at`). |
| `test_results` | `session_pk`, `ts`, `command`, `passed`, `failed`, `skipped`, `duration_ms`. PK (`session_pk`, `ts`). No FK, because a live session may not be indexed yet. |
| `archive_entries` | `path` text pk (the source transcript path), `session_pk`, `agent_id`, `project_id`, `archive_path`, `codec` (`'zstd'\|'gzip'`), `source_size`, `source_mtime_ms`, `bytes`, `archived_at`, `head_fingerprint` (`"<size>:<sha1 of the first 4096 bytes>"`, same format as `file_offsets.head_fingerprint`; catches a same-size rewrite that (size, mtime) cannot; `null` on rows written before the column existed). Index `archive_entries_session_idx` on `session_pk`. |

- **P4 columns** (as built, `apps/daemon/src/db/schema.ts`):

| Table | Columns |
|---|---|
| `worktrees` | `path` pk, `repo`, `branch`, `base`, `ticket`, `dirty`, `pr_url`, `state` (`active`\|`archived`), `created_by_app`, `head`, `is_main`, `origin`, `session_pks_json`, `project_id`, `created_at`, `updated_at`, `archived_at`. Indexes `worktrees_repo_idx`, `worktrees_branch_idx`. |
| `checkpoints` | `id` pk, `session_pk`, `session_id` (source-native id), `worktree_path`, `turn`, `ref`, `commit`, `kind` (`turn`\|`safety`\|`manual`), `created_at`. Unique `checkpoints_ref_uq` on `ref`; indexes on `session_pk` and `worktree_path`. Refs are `refs/orchestrator/checkpoints/<sessionId>/<turn>` for `turn`, and `…/<turn>-safety-<epochMs>-<rand8>` / `…/<turn>-manual-<epochMs>-<rand8>` for the other kinds. |
| `pr_cache` | `key` pk (`${repo}#${number}`), `repo`, `number`, `url`, `state`, `title`, `checks`, `review`, `head_ref`, `failed_checks_json`, `updated_at`, `fetched_at`. Index `pr_cache_head_idx`. |

  A hunk or file revert stores its safety commit at `refs/orchestrator/reverts/<worktree-hash>/<epochMs>` (not a checkpoint row); archiving the worktree deletes that worktree's revert refs.

- **P6 columns** (as built, `apps/daemon/src/db/schema-p6.ts`). No secret is ever stored in SQLite; tokens live in the Keychain (`SecretStore`), device tokens only as hashes:

| Table | Columns |
|---|---|
| `connector_tokens_meta` | `connector` pk, `auth_kind`, `account_id`, `account_label`, `scopes_json`, `cursor_json` (poller cursors), `last_status`, `connected_at`, `last_checked_at` |
| `remote_devices` | `id` pk, `name`, `token_hash` unique, `login`, `created_at`, `last_seen_at`, `revoked_at` |
| `webauthn_credentials` | `id` pk, `device_id`, `public_key`, `counter`, `transports_json`, `created_at`, `last_used_at`. Index on `device_id`. |
| `push_subscriptions` | `id` pk, `device_id`, `endpoint` unique, `p256dh`, `auth`, `created_at`, `last_ok_at`, `failures` |
| `slack_threads` | `inbox_item_id` pk, `session_pk`, `channel`, `root_ts`, `last_seen_ts`, `app_ts_json`, `reactions_done_json`, `state`, `created_at`, `updated_at`. Index on `state`. |

  P6 repos: `db/repos/{connectors,remote,slack-threads}.ts`.

- **Repositories:** each table group has a repo module in `apps/daemon/src/db/repos/<name>.ts` that exports plain functions taking `db: OrcDb` as the first argument, e.g. `upsertSession(db, s)`. **Routes never run SQL directly.** P2 adds `db/repos/inbox.ts`, `db/repos/test-results.ts` and `db/repos/archive.ts`.

```ts
// apps/daemon/src/db/client.ts
export type OrcDb = BetterSQLite3Database<typeof schema>;
export function openDb(file: string): { db: OrcDb; raw: Database.Database; close(): void }  // runs migrations
```

## 6. HTTP API & WebSocket

- **Base URL:** `http://127.0.0.1:4317`. The daemon serves the built web app at `/` and the API at `/api/*`.
- **Auth:**
  - Every `/api/*` and WS request needs the header `x-orc-token: <token>`. WS can use the `?token=` query instead, because browsers can't set WS headers.
  - The web app gets the token from `GET /bootstrap.js`, which only works from a loopback address and sets `window.__ORC_TOKEN__`.
  - WS upgrades must pass an **Origin check**: `http://127.0.0.1:<port>`, `http://localhost:<port>` or the configured Tailscale origin.
  - From P6 on, remote requests (through `tailscale serve`) follow the **Remote auth** rules below: a per-device token instead of the install token, and `/bootstrap.js` answers `window.__ORC_TOKEN__ = null;` to them.
- **Errors:** always `{ error: { code: string; message: string; details?: unknown } }` with a correct HTTP status. Codes are `snake_case`, e.g. `session_live`, `not_found`, `validation_failed`, `forbidden`, `confirmation_required`.
- **Confirmation:** destructive endpoints need `{"confirm": true}` in the body. Without it they return `409 confirmation_required` with a `details.summary` to show the user.
- **Validation:** every request and response schema lives in `@orc/api-contract/src/routes/<area>.ts` as zod. The client is `createApiClient({ baseUrl, token })` in `@orc/api-contract/src/client.ts` and exposes typed methods named `<area><Verb>`, e.g. `sessionsList`, `sessionsGet`, `sessionsResume`.

### Routes (grouped by the phase that adds them)

P1's route table below is the **as-built** shape (reconciled at the phase 1 exit — the code is
authoritative over the plan text it was written against):

```
P1  GET    /api/health                               → { ok, version, uptimeS }
P1  GET    /api/projects                             → Project[]
P1  GET    /api/projects/:id                          → ProjectConfig                          (Task 15 addition — was missing from the original table)
P1  PATCH  /api/projects/:id                         body ProjectUpdate (Partial<ProjectConfig> minus `features`, which is itself Partial)
P1  GET    /api/sessions?q&projectId&source&ticket&pr&from&to&model&minCost&maxCost&skill&hasSubagents&touchedProd&availability&label&pinned&includeHidden&includeAutomated&limit&cursor
                                                     → { items: SessionListItem[]; nextCursor: string | null }
                                                     (SessionListQuery gained `label`, `pinned`, `includeHidden`, `includeAutomated` beyond the original plan — all brief-mandated, additive)
P1  GET    /api/sessions/:source/:id                 → Session
P1  GET    /api/sessions/:source/:id/events?agentId&afterSeq&limit → { items: TimelineEvent[]; nextSeq: number | null }
P1  GET    /api/sessions/:source/:id/agents          → AgentNode[]
P1  POST   /api/sessions/:source/:id/resume          body ResumeRequest { mode: 'embedded'|'external'; fork?; popOut?; cols?; rows? } → ResumeResponse ({ ptyId } | { launched: 'external'; command: string })
                                                     (ResumeRequest gained `popOut`, `cols`, `rows` beyond the original plan — all brief-mandated, additive; all four write-body schemas are `z.strictObject`, see §13)
P1  POST   /api/sessions/:source/:id/pin             body { pinned: boolean } → { pinned: boolean }
P1  POST   /api/sessions/:source/:id/label           body { labels: string[] } → { labels: string[] }
P1  GET    /api/labels                               → string[]                                (not in the original route table)
P1  GET    /api/views                                → SavedView[]                              (not in the original route table)
P1  POST   /api/views                                body { name; query: Record<string,string> } → SavedView
P1  DELETE /api/views/:id                            → { ok: true }
P1  GET    /api/pty                                  → PtyInfo[]
P1  DELETE /api/pty/:ptyId                           body { confirm: true }
P1  WS     /pty/:ptyId                               binary out; client msgs: { t:'in', d:string } | { t:'resize', cols, rows }
P2  GET    /api/live                                 → Session[] (live != null)
P2  POST   /api/sessions/launch                      body LaunchRequest → { ptyId, sessionId | null }
                                                     errors: 400 validation_failed|cwd_not_found|template_var_missing|template_var_invalid, 404 template_not_found, 429 concurrency_limit, 501 not_implemented (planApproval|worktree|compare), 503 templates_unavailable
P2  POST   /api/sessions/:source/:id/kill            body { confirm?: boolean } → { killed: 'pty' | 'pid' }   409 confirmation_required, 404 not_live
P2  POST   /api/sessions/:source/:id/open-in         body { app: 'vscode'|'terminal'|'finder'; remember?: boolean } → { ok: true }
P2  GET    /api/inbox?state=open,snoozed&kind=a,b&projectId → InboxItem[]
P2  POST   /api/inbox/:id/:action{done|snooze|reopen} body { until? } → InboxItem   (snooze requires a future ISO `until`)
P2  GET    /api/templates?projectId                  → Template[]
P2  GET    /api/archive/status                       → ArchiveStatus
P2  POST   /api/archive/restore                      body { source, id, confirm? } → { restored: string[] }   409 confirmation_required|restore_target_exists, 404 not_archived, 400 unsupported_source
P2  POST   /api/archive/sync                         → { copied: number }
P2  GET    /api/config/notifications                 → NotificationPrefs
P2  PUT    /api/config/notifications                 body NotificationPrefs → NotificationPrefs
P2  POST   /api/hooks                                body HookIngestBody → { ok: true }   (P5 extends it in place: maps every BRIDGE_HOOK_EVENTS event and answers { ok: true, accepted })
P2  WS     /ws                                       hello, then LiveEvent deltas (below)
P3  GET    /api/sessions/:source/:id/stats           → SessionStatsResponse { session: SessionStats; turns: TurnStats[]; agents: { agentId: string; stats: SessionStats }[] }
P3  GET    /api/sessions/:source/:id/deliverables    → TurnDeliverables[]
P3  GET    /api/sessions/:source/:id/files           → FileSummary[]
P3  GET    /api/sessions/:source/:id/usage-series    → UsagePoint[] { ts; agentId; model; input; output; cacheRead; cacheWrite; costUsd }
P3  GET    /api/sessions/:source/:id/safety          → SessionSafety { permissionMode; permissionBadge; touchedProd; prodTouches: ProdTouch[] }
P3  GET    /api/sessions/:source/:id/links           → SessionLinks { prs; tickets: {id,url}[]; plans: PlanRef[]; artifacts: {title,url,path}[]; bridgeSessionId }
P3  GET    /api/sessions/:source/:id/raw?agentId&offset&limit → RawPage { path; items: { offset; text; truncated; partial }[]; nextOffset: number | null }
P3  GET    /api/sessions/:source/:id/export?redact=false&confirm=true → application/zip   (audited as session.export; unredacted needs confirm → 409 confirmation_required; 413 export_too_large)
P3  GET    /api/plans?q&limit                        → PlanRef[] { path; title; source: 'claude-plans'|'wakecap-plans'|'repo-docs'; mtime; reason: 'ticket'|'time'|'query'; tickets }
P3  GET    /api/plans/content?path                   → { path; text }  (403 forbidden outside plan roots)
P3  GET    /api/audit?sessionPk&action&actor&from&to&q&projectId&limit → AuditEntry[]
P3  GET    /api/safety/secrets                       → SecretsReport { scannedAt; totalFindings; files: { path; displayPath; exists; findings: SecretFinding[]; error }[] }
P3  POST   /api/safety/deny-check                    body { text; projectId } → DenyVerdict
P4  GET    /api/worktrees?projectId&state&repo          → WorktreeView[]
P4  POST   /api/worktrees/discover                      → WorktreeView[]                                     (NON_ACTION_ROUTES: read-only git)
P4  GET    /api/worktrees/one?path                      → WorktreeView
P4  POST   /api/worktrees                               body CreateWorktreeBody → { worktree: WorktreeView; setupPtyId: string | null; launch: { ptyId: string; sessionId: string | null } | null } (confirm)
P4  POST   /api/worktrees/script                        body { path, which, confirm } → { ptyId }            (confirm)
P4  POST   /api/worktrees/open                          body { path, target } → { ok: true }
P4  GET    /api/worktrees/sync-preview?path             → SyncPreview
P4  POST   /api/worktrees/sync                          body { path, confirm } → { files }                   (confirm)
P4  POST   /api/worktrees/archive                       body { path, confirm, confirmExternal? } → { ok: true } (confirm)
P4  GET    /api/diff?cwd&from&to                        → DiffResult      (from default = merge-base with base; to default = 'WORKTREE')
P4  POST   /api/diff/revert                             body { cwd, file, hunkIndex?, from?, confirm } → { reverted: string } (confirm)
P4  GET    /api/checkpoints?sessionPk                   → CheckpointRecord[]
P4  GET    /api/checkpoints/:id/diff                    → DiffResult      (checkpoint vs previous checkpoint of the session)
P4  POST   /api/checkpoints                             body { sessionPk, confirm } → CheckpointRecord       (confirm; kind 'manual')
P4  POST   /api/checkpoints/:id/rewind                  body { confirm } → { safety: CheckpointRecord }      (confirm)
P4  GET    /api/review/:source/:id                      → ReviewSummary
P4  POST   /api/review/:source/:id/comments             body { comments: ReviewComment[], deliver: 'session'|'text', confirm? } → { sent: boolean; text: string }
P4  GET    /api/ship/suggest?cwd&sessionPk              → ShipSuggestion
P4  POST   /api/ship/commit                             body { cwd, message, confirm } → { sha }             (confirm)
P4  POST   /api/ship/push                               body { cwd, confirm } → { ok: true }                 (confirm)
P4  POST   /api/ship/pr                                 body { cwd, title, body, base, draft, confirm } → PrRef (confirm)
P4  POST   /api/ship/merge                              body { pr, method, confirm } → { ok: true }          (confirm)
P4  POST   /api/ship/backmerge                          body { cwd, projectId, ticket?, confirm } → { ptyId } (confirm)
P4  GET    /api/github/status                           → { status: 'ok'|'unauthenticated'|'error'|'disabled' }
P4  GET    /api/github/pr?repo&number                   → PrStatus
P4  GET    /api/github/prs/mine                         → PrStatus[]
P4  POST   /api/sessions/:source/:id/plan/approve       body { confirm } → { ok: true }                      (confirm)
P4  POST   /api/sessions/:source/:id/plan/reject        body { feedback, confirm } → { ok: true }            (confirm)
P4  POST   /api/sessions/launch                         LaunchRequest.planApproval and .worktree are supported; the P2 501 for both is gone (compare stays 501 until P7)
P5  GET    /api/usage                                   → UsageSnapshot
P5  GET    /api/usage/budgets                           → BudgetStatus[]
P5  PUT    /api/usage/budgets                           body BudgetUpsertBody → Budget                        (NON_ACTION)
P5  DELETE /api/usage/budgets/:id                       → { ok: true }                                       (NON_ACTION)
P5  GET    /api/usage/concurrency                       → ConcurrencyStatus[]
P5  GET    /api/usage/context/:source/:id               → ContextFillInfo | null
P5  POST   /api/usage/official                          raw statusline JSON → 204                            (NON_ACTION)
P5  GET    /api/settings                                → Settings { recaps, limits, digest, hooks }
P5  PUT    /api/settings                                body SettingsUpdateBody → Settings                    (NON_ACTION)
P5  GET    /api/streams?projectId&stage                 → WorkStream[]   (refreshes first when older than 30 s)
P5  POST   /api/streams/refresh                         → WorkStream[]                                       (NON_ACTION)
P5  GET    /api/streams/:ticket                         → StreamDetail
P5  POST   /api/streams/:ticket/link | /unlink          body { kind, ref } → StreamLink                     (NON_ACTION)
P5  GET    /api/analytics/cost?from&to&projectId&groupBy → { rows: CostRow[]; estimated: boolean }
P5  GET    /api/analytics/top?from&to&projectId&limit   → TopResult
P5  GET    /api/analytics/tools?from&to&projectId&bucket → ToolUsageRow[]
P5  GET    /api/analytics/timing?from&to&projectId&bucket → TimingResult
P5  GET    /api/analytics/outcomes?from&to&projectId    → OutcomesResult
P5  GET    /api/analytics/wstack?from&to                → WstackSkillRow[]
P5  GET    /api/analytics/digest                        → DigestRecord | null
P5  POST   /api/analytics/digest                        body { weekStart? } → DigestRecord                   (NON_ACTION)
P5  GET    /api/recaps/session/:source/:id              → Recap | null
P5  POST   /api/recaps/session/:source/:id              body { onDemand } → RecapRunResponse                 (NON_ACTION)
P5  GET    /api/recaps/daily?projectId&date             → Recap | null
P5  POST   /api/recaps/daily                            body { projectId, date } → { text }                 (NON_ACTION)
P5  GET    /api/recaps/spend                            → { spentUsd, budgetUsd }
P5  GET    /api/goals?state                             → Goal[]
P5  GET    /api/goals/:targetType/:targetId             → { goal, prefill }
P5  PUT    /api/goals/:targetType/:targetId             body GoalPutBody → Goal                              (NON_ACTION)
P5  GET    /api/handoffs/session/:source/:id            → { handoff, markdown } | null
P5  POST   /api/handoffs/session/:source/:id            → Handoff                                            (NON_ACTION)
P5  GET    /api/handoffs/:id/markdown                   → text/markdown
P5  POST   /api/handoffs/:id/resume-fresh               body { confirm } → { ptyId }                         (confirm; audited as session.launch)
P5  GET    /api/reminders?state&sessionPk               → Reminder[]
P5  POST   /api/reminders                               body ReminderCreateBody → Reminder                   (NON_ACTION)
P5  POST   /api/reminders/:id/cancel                    → Reminder                                           (NON_ACTION)
P5  GET    /api/hooks/install                           → HookInstallStatus   (never writes)
P5  POST   /api/hooks/install                           body { confirm } → { installed, settingsPath, backupPath } (confirm; audited as hook.install)
P5  GET    /api/hooks/statusline                        → { command, snippet }
P6  GET    /api/connectors                              → ConnectorStatus[]
P6  POST   /api/connectors/:id/token                    body { token } → ConnectorStatus                     (loopback only; audited as connector.connect)
P6  POST   /api/connectors/:id/app                      body { clientId, clientSecret } → { ok }             (loopback only; audited as connector.configure)
P6  GET    /api/connectors/:id/authorize                → { url }                                            (loopback only; Slack only — Linear answers 404, no Linear OAuth)
P6  GET    /api/connectors/:id/callback?code&state      → text/html                                          (public, GET only: no token; one-time state)
P6  DELETE /api/connectors/:id                          body { confirm } → { ok }                            (loopback only; audited as connector.disconnect)
P6  GET    /api/linear/issues/:identifier               → LinearIssue
P6  POST   /api/linear/issues/:identifier/comment       body LinearCommentBody → { ok } | 409 preview         (audited as linear.comment)
P6  POST   /api/linear/follow-up                        body LinearFollowUpBody → LinearIssue | 409 preview   (audited as linear.issue.create)
P6  POST   /api/slack/post                              body SlackPostBody → { ts } | 409 preview             (audited as slack.post)
P6  POST   /api/sessions/:source/:id/reply              body { text } → { ok }                               (owned only; remote: step-up; audited as pty.input)
P6  POST   /api/inbox/:id/approve                       body { confirm } → InboxItem                          (remote: step-up; audited as remote.approve | inbox.approve)
P6  GET    /api/remote/status                           → RemoteStatus
P6  POST   /api/remote/config                           body { enabled, origin, allowedLogin } → RemoteStatus (loopback only; uses ctx.updateConfig; audited as remote.configure)
P6  POST   /api/remote/pairing                          → { code, expiresAt, url }                           (loopback only; audited as remote.pairing_code)
P6  POST   /api/remote/pair                             body { code, name } → { deviceId, deviceToken }      (remote only; no token; audited as remote.pair)
P6  GET    /api/remote/devices                          → RemoteDevice[]                                     (loopback only)
P6  DELETE /api/remote/devices/:id                      body { confirm } → { ok }                            (loopback only; audited as remote.revoke)
P6  GET    /api/remote/away                             → AwayState
P6  POST   /api/remote/away                             body { mode: 'auto'|'on'|'off' } → AwayState          (audited as away.set)
P6  POST   /api/webauthn/register/options | /api/webauthn/register/verify               (remote device only; verify audited as webauthn.register)
P6  POST   /api/webauthn/stepup/options   | /api/webauthn/stepup/verify → { validUntil } (remote device only)
P6  GET    /api/push/vapid-public-key → { publicKey } ; POST /api/push/subscriptions → { ok } ; DELETE /api/push/subscriptions body { endpoint } → { ok } ; POST /api/push/test → { sent }
P7  GET    /api/automations                          → AutomationWithStats[]
P7  POST   /api/automations                          body AutomationInput → Automation                    (settings.update)
P7  GET    /api/automations/settings                 → AutomationSettings { enabled, maxConcurrent, suggestionsEnabled }
P7  PATCH  /api/automations/settings                 body AutomationSettingsPatch → AutomationSettings    (settings.update)
P7  GET    /api/automations/suggestions?state        → Suggestion[]
P7  POST   /api/automations/suggestions/refresh      → { added: number }                                  (NON_ACTION_ROUTES)
P7  POST   /api/automations/suggestions/:id/accept   body { confirm: true } → { ptyId, sessionPk }       (session.launch)
P7  POST   /api/automations/suggestions/:id/dismiss  → Suggestion                                         (NON_ACTION_ROUTES)
P7  GET    /api/automations/runs/:runId              → AutomationRunDetail
P7  GET    /api/automations/runs/:runId/log          → { lines: string[] }                                (redacted)
P7  POST   /api/automations/runs/:runId/approve      body { confirm: true } → AutomationRunDetail (202)   (automation.approve)
P7  POST   /api/automations/runs/:runId/reject       → AutomationRunDetail                                (automation.reject)
P7  POST   /api/automations/runs/:runId/rerun        → AutomationRunDetail | { deduped: true }            (automation.run)
P7  GET    /api/automations/:id                      → AutomationWithStats
P7  DELETE /api/automations/:id                      body { confirm: true }                               (settings.update)
P7  POST   /api/automations/:id/enabled              body { enabled: boolean } → Automation               (settings.update)
P7  POST   /api/automations/:id/run                  body AutomationRunRequest { vars? } → AutomationRunDetail (202)   (automation.run)
P7  GET    /api/automations/:id/runs                 → AutomationRunDetail[]
P7  POST   /api/compare                              body LaunchRequest (compare required) → CompareGroup (201)   (compare.launch)
P7  GET    /api/compare/estimate?projectId&n         → CompareEstimate
P7  GET    /api/compare/:groupId                     → CompareView
P7  POST   /api/compare/:groupId/winner              body { index } → { group: CompareGroup; reviewUrl: string }   (compare.pick)
P7  POST   /api/compare/:groupId/archive-losers      body { confirm: true } → ArchiveLosersResult         (compare.archive)
P7* POST   /api/sessions/launch                      body.compare non-empty → 201 { compareGroupId } (LaunchResponse is a union; 409 not_enabled without ctx.compare)
P7  GET    /api/supervisor/status                    → SupervisorStatus
P7  PATCH  /api/supervisor/settings                  body SupervisorSettingsPatch → SupervisorStatus     (settings.update)
P7  GET    /api/supervisor/targets                   → SupervisorTarget[]
P7  PUT    /api/supervisor/targets                   body SupervisorTarget → SupervisorTarget             (settings.update)
P7  GET    /api/supervisor/rules                     → SupervisorRule[]
P7  POST   /api/supervisor/rules                     body SupervisorRuleInput → SupervisorRule            (supervisor.rule)
P7  DELETE /api/supervisor/rules/:id                 body { confirm: true }                               (supervisor.rule)
P7  GET    /api/supervisor/decisions?sessionPk&limit → SupervisorDecisionView[]
P7  POST   /api/supervisor/decisions/:id/wrong       → SupervisorRule                                     (supervisor.feedback)
P7  POST   /api/supervisor/evaluate/:source/:id      → SupervisorDecisionView                             (supervisor.answer | supervisor.escalate)
P7  GET    /api/connectors/agnc/status               → AgncStatus { enabled, status, url, sessions }
P7  POST   /api/connectors/agnc/connect              → { authorizationUrl: string | null }                (loopback only; agnc.connect)
P7  POST   /api/connectors/agnc/disconnect           body { confirm: true } → { ok }                      (loopback only; agnc.disconnect; forgets the stored tokens)
P7  GET    /oauth/agnc/callback?code&state           → text/html   (public, GET only, in PUBLIC_API_PATHS; state checked before the code reaches AGNC)
P7  GET    /api/agnc/sessions/:id/messages           → AgncMessage[]
P7  GET    /api/agnc/sessions/:id/events?cursor      → { items: AgncEvent[]; nextCursor }
P7  POST   /api/agnc/sessions/:id/prompt             body { prompt, model?, confirm: true } → { ok }      (agnc.prompt; prompt redacted before it leaves, never audited)
P7  POST   /api/agnc/handoff                         body { source, id, confirm: true } → AgncSession     (agnc.create)
```

**P7 routes** are registered once, in `registerAllRoutes` (`http/app.ts`), by `register{Automation,Compare,Supervisor,Agnc}Routes(app, ctx)` and `registerAgncOAuthRoute`; each reads its service per request with `need(ctx.<svc>, name)` from `http/p7-guard.ts` and answers `409 not_enabled` while it is unset (the AGNC routes also while `agnc.enabled` is off). Every P7 write route is in `AUDITED_ROUTES` with `recordedBy: 'service'` (the service records the entry with the real actor and params; the middleware records only a request that fails before it does), except `POST /api/automations/suggestions/refresh` and `…/:id/dismiss`, which are in `NON_ACTION_ROUTES`. `apps/daemon/test/p7/m7-exit.test.ts` checks this for every P7 write route. Run lists, run logs, suggestions, compare views, supervisor decisions and AGNC messages/events answer through `redactedJson`. Phase 7 adds no `REMOTE_RULES` entry: remote writes to P7 routes get the default `403 remote_forbidden`.

`AutomationRunRequest = z.strictObject({ vars: z.partialRecord(TemplateVarSchema, z.string()).optional() })` (fix `576598b`): only the template's known var names, string values; anything else is `400 validation_failed`. `automationsRun(id, vars?)` sends it.

`LaunchResponse = z.union([LaunchSessionResponse { ptyId, sessionId: string | null }, LaunchCompareResponse { compareGroupId }])` (`routes/launch.ts`); callers narrow on `'compareGroupId' in r`.

P7's zod schemas live in `packages/api-contract/src/routes/{automations,compare,supervisor,agnc,p7-common}.ts`. The client methods live in `packages/api-contract/src/clients/{automations,compare,supervisor,agnc}.ts`, combined by `phase7Client(call: ApiCall): Phase7Api` (`clients/phase7.ts`), and `interface ApiClient extends Phase7Api`.

**P7 error codes:** `not_enabled`, `over_budget`, `capacity_exceeded`, `invalid_state`, `confirmation_required`, `session_unknown` (all `409`), `not_owned` (`403`), `not_found` (`404`), `validation_failed` (`400`, including an invalid cron expression and unknown run-now vars). A guard refusal of an automation run is not an HTTP error: the run is recorded with status `denied` or `over_budget`.

**P7 inbox items** (`inbox.upsert({ kind, scope })`; keys composed by the InboxEngine):
- `automation_result` with `scope: { domain: 'automation-run', id: runId }` — a finished, failed, denied or over-budget run.
- `plan_approval` with `scope: { domain: 'automation-run', id: runId }` — a headless run waiting in `awaiting_approval`; approve or reject resolves it.
- `supervisor_escalation` with `scope: { session: sessionPk }` — the supervisor did not answer.
- `waiting` with `scope: { session: sessionPk }` is **resolved** (not created) after the supervisor sends an answer.

P2's zod schemas live in `packages/api-contract/src/routes/{live,launch,inbox,templates,archive,notifications,hooks}.ts`, with `export type LaunchRequest = z.infer<typeof LaunchRequest>` and `ArchiveStatus = z.object({ enabled, files, bytes, oldestTranscript, cleanupPeriodDays, codec, recommendedSnippet })`. P2's client methods (`packages/api-contract/src/client-p2.ts`, folded into `createApiClient`) are `liveList`, `sessionsLaunch`, `sessionsKill`, `sessionsOpenIn`, `inboxList`, `inboxDone`, `inboxSnooze`, `inboxReopen`, `templatesList`, `archiveStatus`, `archiveRestore`, `archiveSync`, `notificationsGet`, `notificationsPut`.

P3's zod schemas live in `packages/api-contract/src/routes/{session-detail,links,safety,audit}.ts`. They reuse `UsageSchema` from `packages/api-contract/src/domain.ts` rather than declaring a second one. P3's client methods (`packages/api-contract/src/client-p3.ts`, folded into `createApiClient`) are `sessionsStats`, `sessionsDeliverables`, `sessionsFiles`, `sessionsUsageSeries`, `sessionsSafety`, `sessionsLinks`, `sessionsRaw`, `sessionsExport`, `plansList`, `plansContent`, `auditList`, `safetySecrets`, `safetyDenyCheck`. They throw P1's `ApiRequestError`; `client-p3.ts` re-exports it under the alias `ApiCallError` for the Phase 3 tests only, and it is the same class (§13).

P4's zod schemas live in `packages/api-contract/src/routes/`: `worktrees.ts` (`WorktreeViewSchema`, `WorktreeType`, `CreateWorktreeBody`, `CreateWorktreeResult`, `WorktreeListQuery`, `WorktreeScriptBody`, `WorktreeOpenBody`, `SyncPreview`, `WorktreePathBody`, `WorktreeArchiveBody`), `review.ts` (`DiffQuery`, `DiffFileSchema`, `DiffResultSchema`, `DiffRevertBody`, `CheckpointRecordSchema`, `CheckpointCreateBody`, `CheckpointRewindBody`, `ReviewCommentSchema`, `ReviewCommentsBody`, `ReviewSummarySchema`), `ship.ts` (`ShipPrRefSchema`, `PrStatusSchema`, `ShipSuggestion`, `ShipCommitBody`, `ShipPushBody`, `ShipPrBody`, `ShipMergeBody`, `ShipBackmergeBody`), `plan.ts` (`PlanApproveBody`, `PlanRejectBody`), and `common.ts` (`Confirm`, `IsoString`). P4's client methods live in `packages/api-contract/src/client-phase4.ts` (`createPhase4Methods`, type `Phase4Client`), spread into `createApiClient`: `worktreesList`, `worktreesDiscover`, `worktreesGet`, `worktreesCreate`, `worktreesScript`, `worktreesOpen`, `worktreesSyncPreview`, `worktreesSync`, `worktreesArchive`, `diffGet`, `diffRevert`, `checkpointsList`, `checkpointsDiff`, `checkpointsCreate`, `checkpointsRewind`, `reviewGet`, `reviewComments`, `shipSuggest`, `shipCommit`, `shipPush`, `shipPr`, `shipMerge`, `shipBackmerge`, `planApprove`, `planReject`, `githubStatus`, `githubPr`, `githubMine`.

P5's zod schemas live in `packages/api-contract/src/routes/{usage,settings,streams,analytics,recaps,goals,reminders,handoffs,hooks}.ts`. P5's client methods live in `packages/api-contract/src/client-p5.ts` (`p5ClientMethods`, type `P5ClientMethods`), spread into `createApiClient`: `usageGet`, `usageBudgets`, `usageBudgetUpsert`, `usageBudgetDelete`, `usageConcurrency`, `usageContext`, `settingsGet`, `settingsUpdate`, `analyticsCost` (its `groupBy` is required), `analyticsTop`, `analyticsTools`, `analyticsTiming`, `analyticsOutcomes`, `analyticsWstack`, `analyticsDigestLatest`, `analyticsDigestGenerate`, `streamsList`, `streamsRefresh`, `streamsGet`, `streamsLink`, `streamsUnlink`, `recapsGetSession`, `recapsRunSession`, `recapsGetDaily`, `recapsRunDaily`, `recapsSpend`, `goalsList`, `goalsGet`, `goalsSet`, `handoffsLatest`, `handoffsGenerate`, `handoffsResumeFresh`, `remindersList`, `remindersCreate`, `remindersCancel`, `hooksInstallStatus`, `hooksInstall`, `hooksStatusline`.

**P5 routes** are registered on the main app by `register{Usage,Settings,Stream,Analytics,Recap,Goal,Reminder,Handoff}Routes` (`http/app.ts`); each reads its service with `need(ctx.<svc>, name)` (`services/need.ts`, which throws `<name> is not wired in DaemonContext` while unset) and parses with `readBody`/`readQuery` from `http/p5-util.ts`. Every P5 body that can carry transcript-derived text (stream titles, timelines, recaps, goals, reminders, handoffs, analytics names, the digest) answers through `redactedJson`.

**P5 LiveEvent change:** `usage.updated` is typed `{ type: 'usage.updated'; snapshot: UsageSnapshot }` and goes through `toWireEvent` like the rest.

**P5 BusEvent additions** (daemon-internal): `{ type: 'config.changed' }` (emitted by `ctx.updateConfig`), `{ type: 'index.initialComplete' }` (emitted by `createDaemon().start()` once the first `scanAll` finishes; the stream service rebuilds on it).

**P4 errors.** Routes are mounted on `phase4App()` (`http/routes/git-guard.ts`), whose `onError` answers every error through `redactedApiError`. Services throw `GitError` (`services/git/exec.ts`) or P1's `ServiceError` (`services/errors.ts`); `toHttpError` maps a `GitError` to a `ServiceError` with the status from `GIT_ERROR_STATUS`. There is no `HttpError`. Codes and statuses: `not_found`, `not_a_worktree`, `no_worktree`, `hunk_not_found`, `no_script` → 404; `not_owned` → 403; `forbidden_git_args`, `validation_failed` → 400; `dirty_worktree`, `main_dirty`, `external_worktree`, `worktree_exists`, `is_main_checkout`, `nothing_to_commit`, `protected_branch`, `push_rejected`, `no_pending_plan`, `confirmation_required` → 409; `git_failed` → 502; `gh_unavailable` and `unavailable` (service not wired on `ctx`) → 503.

**P4 LiveEvent additions** (`packages/api-contract/src/live.ts`, forwarded to `/ws`, appended to `LIVE_EVENT_TYPES`): `{ type: 'worktree.updated'; worktree: WorktreeView }`, `{ type: 'worktree.removed'; path: string }`, `{ type: 'pr.updated'; status: PrStatus }`, `{ type: 'checkpoint.created'; checkpoint: CheckpointRecord }`.

**P4 BusEvent additions** (daemon-internal, `apps/daemon/src/live/event-bus.ts`): `{ type: 'pr.changed'; before: PrStatus | null; after: PrStatus }`, `{ type: 'plan.pending'; pk: string; plan: string; toolUseId: string }`, `{ type: 'pr.reviewRequested'; pr: PrRef; title: string; active: boolean }` (`active: false` when the request goes away).

**P6 routes** are registered once, in `registerAllRoutes` (`http/app.ts`), by `register{Connector,Share,SessionAction,Remote,WebAuthn,Push,Away}Routes(app, ctx, deps?)`. The optional `deps` are for tests; in the daemon each handler reads its service per request (`ctx.linear`, `ctx.slack`, `ctx.secrets`, `ctx.share`, `ctx.sessionActions`, `ctx.away`, `ctx.remoteAccess`) through `need()` from `http/p6-util.ts` and answers `503 unavailable` while it is unset. There is no `Phase6.register` hook. P6 zod schemas live in `packages/api-contract/src/routes/connectors.ts` (`ConnectorId`, `ConnectorStatus`, `TokenBody`, `OAuthAppBody`, `LinearIssue`, `ShareSource`, `LinearCommentBody`, `LinearFollowUpBody`, `SlackPostBody`) and `routes/remote.ts` (`PairBody`, `PairResult`, `PairingCode`, `RemoteDevice`, `RemoteConfigBody`, `RemoteStatus`, `AwayMode`, `AwayState`, `AwayBody`, `ReplyBody`, `ApproveBody`, `PushSubscriptionBody`, `PushUnsubscribeBody`, `StepUpResult`, `WebAuthnVerifyBody`).

**P6 error codes:** `loopback_only`, `remote_only`, `remote_disabled`, `remote_identity_mismatch`, `remote_bad_host`, `remote_forbidden`, `funnel_detected`, `step_up_required` (401), `step_up_failed`, `not_owned`, `denied`, `not_approvable`, `invalid_code`, `invalid_token`, `invalid_token_format`, `oauth_not_configured`, `invalid_state`, `unauthenticated`, `upstream_error` (502), `registration_window_closed`, `unknown_credential`, `bad_push_endpoint`, `unavailable` (503). The remote guard's own refusals are `403` except `unauthorized` and `step_up_required` (`401`).

**P6 remote auth** (`http/remote-guard.ts`, `http/auth.ts`, `http/ws-remote.ts`, `remote/classify.ts`):
- A request is **remote** (`isRemoteRequest`) when any of these holds: the socket address is not loopback; `Tailscale-User-Login` or `Tailscale-User-Name` is present; any `X-Forwarded-For`/`-Host`/`-Proto` or `Forwarded` header is present; the Host hostname is not `127.0.0.1`, `localhost` or `::1`.
- `remoteGuard(deps)` runs first on every path (`app.use('*', …)`) and sets `c.var.remote: RemoteInfo | null`. `RemoteInfo = { deviceId: string | null; deviceName: string | null; login: string }`; handlers read it through `remoteOf(c)` and turn it into an audit actor with `whoOf(c)` (`{ actor: 'remote', actorDetail: "<device> (<login>)" }`). `remoteGuard(null)` marks every request local (P1 tests only).
- `OrcEnv = { Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } }`, `OrcApp = Hono<OrcEnv>` (`http/types.ts`).
- Remote checks, in order (`evaluateRemote`): `remote.enabled`, an `https:` `remote.origin` and a non-blank trimmed `remote.allowedLogin`, else `403 remote_disabled`; Funnel detected → `403 funnel_detected`; `Tailscale-User-Login` must equal `allowedLogin` (case-insensitive, constant-time) → `403 remote_identity_mismatch`; `X-Forwarded-Host` or `Host` hostname must equal the origin's → `403 remote_bad_host`; an `Origin` header must equal `remote.origin` → `403 forbidden`; then the route policy.
- Route policy `REMOTE_RULES` (first match wins) plus defaults in `remotePolicy(method, path)`: `public` — the two OAuth callbacks (GET), `POST /api/remote/pair`, `GET /api/health`; `deny` — `GET /api/remote/(devices|pairing)`, `GET /api/connectors…`, session `export`/`raw`, `safety/secrets`, `hooks/install`, `archive`; `device` — WebAuthn options/verify, push subscriptions/test, `POST /api/remote/away`, inbox `snooze|done|reopen`; `stepup` — `POST /api/inbox/:id/approve`, `POST /api/sessions/(claude|codex)/:id/(reply|kill)`, `POST …/plan/(approve|reject)`, `DELETE /api/pty/:id`, `POST /api/ship/merge`. Defaults: other `GET /api/*` → `device`, other API writes → `deny` (`403 remote_forbidden`), `GET /ws` → `device`, `/pty/*` → `deny`, other static `GET`/`HEAD` → `public`.
- Device tokens: 32 random bytes base64url, sent as `x-orc-token` (or `?token=` on WS), stored only as a sha256 `token_hash`. The install token is never accepted from a remote request. A missing or revoked device token → `401 unauthorized`; a `stepup` route without a live grant → `401 step_up_required`. A step-up lasts `remote.stepUpTtlSec` (in memory, per device).
- `apiAccessMiddleware` (the P1 host, Origin and install-token checks) skips requests `remoteGuard` classified as remote. `PUBLIC_API_PATHS` (the two OAuth callbacks) skip the token check for `GET` only, and never the host check.
- WS: `checkWsUpgrade` runs `evaluateRemote` on remote upgrades, so `/ws` needs a device token and its Origin must be `remote.origin`; `/pty/*` is refused remotely. Local upgrades keep the P1/P2 token and Origin checks unchanged.
- Funnel: `createFunnelWatch` reads `tailscale serve status --json` and treats any `AllowFunnel` entry as Funnel on. The key is an assumption until spike S9 check (h) confirms it.

**P6 BusEvent additions** (daemon-internal; not forwarded to `/ws`): `{ type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }` (assigned-to-me poller; `before: null` means newly assigned), `{ type: 'slack.mention'; channel: string; ts: string; text: string }` (`text` already redacted), `{ type: 'away.changed'; away: boolean; reason: 'manual' | 'idle' | 'present' }`. P6 adds no `LiveEvent` variant.

**P2 BusEvent additions:** none. Phase 2 emits the existing `session.statusChanged`, `session.turnEnded`, `tests.recorded`, `hook.received`, `session.updated`, `session.removed` and `inbox.upserted`.

### WS `/ws` live events
```ts
export type LiveEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; pk: string }
  | { type: 'inbox.upserted'; item: InboxItem }
  | { type: 'pty.exited'; ptyId: string; code: number | null }
  | { type: 'index.progress'; done: number; total: number }
  | { type: 'usage.updated'; snapshot: UsageSnapshot }    // typed in phase 5
  | { type: 'hello'; serverTime: string }
  | { type: 'audit.recorded'; entry: AuditEntry }         // P3; also in the daemon's LIVE_EVENT_TYPES
  | { type: 'automation.runUpdated'; run: AutomationRunDetail }       // P7
  | { type: 'compare.updated'; group: CompareGroup }                  // P7
  | { type: 'supervisor.decided'; decision: SupervisorDecisionView }; // P7
```
P7's three variants go through `toWireEvent` like the rest. P7 adds no `BusEvent` variant of its own: automation triggers subscribe to P4's `pr.changed` and P6's `linear.issueChanged` and `slack.mention` (`services/automations/dispatcher.ts`), and the supervisor to P1's `session.statusChanged`.
- The server sends `hello` on connect, then deltas.
- The web app maps events onto TanStack Query cache updates with `queryClient.setQueryData`.
- Query keys: `['sessions', filters]`, `['session', source, id]`, `['live']`, `['inbox', filters]`, `['projects']`.

### Event bus (daemon-internal)
```ts
// apps/daemon/src/live/event-bus.ts
export type BusEvent = LiveEvent
  | { type: 'hook.received'; payload: unknown }
  | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
  | { type: 'session.turnEnded'; pk: string; turn: number }
  | { type: 'session.indexed'; pk: string }   // P1: emitted by the indexer whenever a session's rows change (new file, append, truncation-recovery re-read); daemon-internal only, not on the /ws LiveEvent wire
  | { type: 'tests.recorded'; pk: string; result: TestResult }
  | { type: 'config.changed' }         // P5
  | { type: 'index.initialComplete' }  // P5
  | { type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }   // P6
  | { type: 'slack.mention'; channel: string; ts: string; text: string }              // P6
  | { type: 'away.changed'; away: boolean; reason: 'manual' | 'idle' | 'present' };   // P6
export interface EventBus { emit(e: BusEvent): void; on<T extends BusEvent['type']>(type: T, fn: (e: Extract<BusEvent, { type: T }>) => void): () => void }
export function createEventBus(): EventBus
```

## 7. PTY & session ownership
```ts
// apps/daemon/src/pty/pty-manager.ts
export interface PtyInfo { id: string; sessionPk: string | null; command: string; args: string[]; cwd: string; pid: number; startedAt: string; exitedAt: string | null; exitCode: number | null; cols: number; rows: number }
export interface PtyManager {
  spawn(opts: { command: string; args: string[]; cwd: string; sessionPk?: string | null; cols?: number; rows?: number; env?: Record<string, string> }): PtyInfo;
  write(id: string, data: string): void;              // raw
  sendText(id: string, text: string): Promise<void>;   // bracketed paste + Enter, waits for idle (from spike S8)
  resize(id: string, cols: number, rows: number): void;
  kill(id: string, signal?: NodeJS.Signals): void;
  attach(id: string, onData: (chunk: string) => void): { scrollback: string; detach(): void };
  list(): PtyInfo[];
  get(id: string): PtyInfo | undefined;
  remove(id: string): void;        // P1 addition: drops a PTY's entry (e.g. after DELETE /api/pty/:ptyId once exited)
  disposeAll(): void;              // P1 addition: kills every live PTY, used on daemon shutdown (close())
}
export function createPtyManager(opts: { bus: EventBus; scrollbackBytes?: number }): PtyManager
```
- **Owned** means `LiveState.ownership = 'owned'`. The session pk maps to a live `PtyInfo`.
- Only owned sessions accept input. Anything else returns `403 not_owned`.

## 8. Redaction, logging, IDs
- `@orc/core/src/redact/redact.ts` exports `redact(text: string): string` and `REDACTION_PATTERNS`. The patterns cover:
  - `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `sk-`
  - `xox[abposr]-`
  - `AKIA[0-9A-Z]{16}`
  - `postgres(ql)?://user:pass@`, `mongodb(+srv)?://…@`
  - `password=`, `pwd=`, `secret=`, `token=`, `api_key=` (P7: an unquoted value now stops at whitespace, `&`, `;`, `)`, `]`, `}`, `'` or `"`, so `(token=abc)` and `{"env":"API_KEY=abc"}` keep their closing punctuation)
  - `Authorization: Bearer …`

  Matches are replaced with `«redacted:<kind>»`.
- **P3 additions** in the same file:
  ```ts
  export function redactDeep<T>(value: T): T        // redacts every string; values under sensitive keys (…password|passwd|secret|api_key|authorization|token) become «redacted:secret»
  export function redactPartialTokens(text: string): string // masks token prefixes cut off by FTS snippets as «redacted:partial»
  ```
- **Where redaction happens:** API responses that carry transcript text (`events`, `sessions` list snippets, export) are redacted **in the route layer**. The DB keeps the raw text.
- Routes send transcript JSON through `redactedJson` (`apps/daemon/src/http/redacted-json.ts`). FTS snippets use the daemon's `redactSnippet` (which composes `redactPartialTokens`). WS events pass through `toWireEvent` (`apps/daemon/src/http/ws-redact.ts`). Error bodies go through `redactedApiError(code, message, details?)` in `apps/daemon/src/http/redact-out.ts`, because messages and details can carry cwds, session names and zod issues.
- **P5:** every P5 route that returns transcript-derived text answers through `redactedJson`; `usage.updated` goes through `toWireEvent`.
- **P7:** run logs are redacted line by line (`redactStreamLine`); the supervisor classifier gets only the redacted question; an escalation stores the redacted question; AGNC prompts are redacted before they leave; the stdout bridge line carries `redact(item.reason)`.
- **LLM calls** (recaps, daily recaps, handoffs) send only a redacted digest built by `buildRecapDigest`. Tool outputs and tool inputs are never sent.
- **Logging:** pino writes JSON to `$ORC_HOME/logs/daemon.log`, and pretty output in dev. Transcript text is never logged.
- **IDs:** `crypto.randomUUID()`, except that the session pk is `${source}:${id}`.

## 9. Testing conventions
- **Vitest workspace:** `packages/*` and `apps/daemon` use the `node` environment. `apps/web` uses `jsdom` for units and Playwright for e2e (`apps/web/e2e`).
- **Fixtures (`fixtures/`)**, all redacted and small:
  - `fixtures/claude-home/`, which mirrors the real layout:
    - `projects/-Users-test-Wakecap/…`
    - `sessions/`
    - `history.jsonl`
    - `usage-data/`
    - `plans/`
  - `fixtures/codex-home/`
  - Tests set `CLAUDE_HOME`, `CODEX_HOME` and `ORC_HOME` to temp copies using the `useTempHomes()` helper from `apps/daemon/test/helpers.ts`.
- **Minimum fixture sessions** (created in Phase 0 Task 2):

  | Fixture | Content |
  |---|---|
  | `s-basic` | 3 prompts, Bash + Edit, cost-state, ai-title |
  | `s-subagents` | 3-level nesting, background agent |
  | `s-prlink` | pr-link + ticket SAF-1787 in prompt |
  | `s-drift` | cwd drift from `/Users/test/Wakecap` → `/Users/test/Wakecap/Backend/svc` |
  | `s-errors` | API error, `<synthetic>` model, truncated last line |
  | `s-unknown` | unknown record types |
  | `codex-basic` | rollout with session_meta, token_count |
  | `codex-automated` | `originator: codex_sdk_ts` |

- **P5 test isolation:** `apps/daemon/test/setup-env.ts` points `WSTACK_HOME` at an empty temp dir for every daemon test file; tests that need workflows stub it with `vi.stubEnv`. Recap tests use fake engines or `apps/daemon/test/bin/fake-claude-print`; no test reaches the Anthropic API.
- **P6 test isolation:** no test touches the real Keychain, Linear, Slack, a push service, `ioreg` or `tailscale`. Every `createDaemon` in a test passes `phase6: offlinePhase6()` (`apps/daemon/test/p6-connector-fakes.ts`: memory `SecretStore`, fake Linear and Slack APIs, fake push sender, fake idle reader, fake `tailscale` runner); `secret-store.test.ts` mocks `@napi-rs/keyring` with an in-memory fake, and other tests use `createMemorySecretStore`. Remote-request tests use `withRemote(app)` and `p6Context()` from `apps/daemon/test/p6-fakes.ts`. There is no real-Keychain (`ORC_TEST_KEYCHAIN=1`) test.
- **Daemon HTTP tests** use `app.request()` (Hono) without opening a port. WS/PTY tests use a real ephemeral port (`port: 0`).
- **External CLIs** (`claude`, `codex`, `gh`, `git`) are faked in unit tests with small shell scripts in `apps/daemon/test/bin/`, prepended to `PATH`. Real `git` is used in temp repos for worktree and checkpoint tests.

## 10. Git & commit conventions
- **Branches:** one per phase, `phase/<n>-<slug>` (e.g. `phase/1-history-search-resume`), merged to `main` when the phase exit check passes.
- **Commits:** Conventional Commits with a scope, e.g. `feat(core): parse cost-state records`, `test(daemon): …`, `chore(repo): …`, `docs(plan): …`. Every commit made by an agent ends with the attribution lines required by the session.
- **Before every commit:** `pnpm lint && pnpm typecheck && pnpm test` must pass. Each task's last step runs this.

## 11. Cross-phase service interfaces

Later phases call these services. The **owning phase** implements the exact signature, and **consuming phases** use it without redefining it. Every service is created in `apps/daemon/src/main.ts` → `createDaemon()` and passed through `DaemonContext`.

```ts
// apps/daemon/src/context.ts  (Phase 1 creates; later phases add optional fields)
// As-built P1 note: there is NO `sessions.owned_by_app` column anywhere in the schema (§5's
// `sessions` table has no such column) — ownership ('observed' | 'owned', see §4's `Ownership`
// type) is a route/service-level concept computed from whether a live PtyInfo exists for the
// session's pk, not a persisted column. §11's DaemonContext note that implied a column was wrong;
// reconciled at the phase 1 exit (Task 6/20 ruling).
export interface DaemonContext {
  paths: OrcPaths;
  config: () => OrcConfig;                 // live getter (config can change at runtime)
  db: OrcDb;
  bus: EventBus;
  log: import('pino').Logger;
  pty: PtyManager;                         // P1
  sessions: SessionService;                // P1
  projects: ProjectServiceImpl;            // P1 — as-built name; ProjectService is the narrower public interface it extends (see below)
  userMeta: UserMetaService;               // P1 — pins/labels/saved views; not anticipated by the original §11 draft
  live?: LiveTracker;                      // P2
  inbox?: InboxEngine;                     // P2
  notifier?: Notifier;                     // P2
  updateConfig?: (fn: (cfg: OrcConfig) => OrcConfig) => OrcConfig;   // P2 — replaces the config and persists it via saveConfig
  templates?: TemplateRegistry;            // P2
  launcher?: LaunchService;                // P2
  archive?: ArchiveServiceRuntime;         // P2 — narrows the contract's ArchiveService (superset); the /api/archive routes answer 503 archive_unavailable while it is unset
  audit: AuditService;                     // P3 — required, always set by buildContext()
  denyList: DenyList;                      // P3 — required, always set by buildContext()
  worktrees?: WorktreeService;             // P4
  checkpoints?: CheckpointService;         // P4
  ship?: ShipService;                      // P4
  github?: GithubConnector;                // P4
  diff?: DiffService;                      // P4
  review?: ReviewService;                  // P4
  plans?: PlanApprovalService;             // P4 — all P4 services are set by wirePhase4(), not buildContext()
  scheduler?: Scheduler;                   // P5 — extended in P7
  ledger?: UsageLedger;                    // P5
  usage?: UsageMeter;                      // P5
  prs?: PrSource;                          // P5
  streams?: StreamService;                 // P5
  analytics?: AnalyticsService;            // P5
  digests?: DigestService;                 // P5
  recaps?: RecapService;                   // P5
  goals?: GoalService;                     // P5
  reminders?: ReminderService;             // P5
  handoffs?: HandoffService;               // P5 — every P5 service is set by buildContext(); the ones with start() are started by createDaemon().start()
  linear?: LinearConnector;                // P6
  slack?: SlackConnector;                  // P6
  secrets?: SecretStore;                   // P6
  share?: ShareService;                    // P6
  sessionActions?: SessionActions;         // P6
  away?: AwayService;                      // P6
  remoteAccess?: RemoteAccess;             // P6 — { devices, pairing, stepUp, funnel, webauthn, vapid, webpush }; every P6 field is set by createPhase6(), not buildContext()
  automations?: AutomationServiceImpl;     // P7 — superset of AutomationService (below)
  suggestions?: SuggestionService;         // P7
  compare?: CompareService;                // P7
  supervisor?: SupervisorImpl;             // P7 — superset of Supervisor (below)
  agnc?: AgncConnector;                    // P7 — every P7 field is set by createPhase7(), not buildContext()
}
```
Once its phase has shipped, code must treat an optional service as present. Tests build a context with `createTestContext(overrides)` from `apps/daemon/test/helpers.ts` (created in P1 and extended by each phase).

```ts
// P1 — apps/daemon/src/services/sessions.ts (as-built; SessionListQuery/ResumeRequest gained fields beyond the original plan — see §6)
export interface SessionListQuery { q?: string; projectId?: string; source?: Source; ticket?: string; pr?: string; from?: string; to?: string; model?: string; minCost?: number; maxCost?: number; skill?: string; hasSubagents?: boolean; touchedProd?: boolean; availability?: Availability; label?: string; pinned?: boolean; includeHidden?: boolean; includeAutomated?: boolean; limit?: number; cursor?: string }
export interface SessionListItem { pk: string; source: Source; id: string; projectId: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null; recap: string | null; startedAt: string; lastActivityAt: string; durationMs: number; costUsd: number | null; tickets: string[]; prs: PrRef[]; availability: Availability; pinned: boolean; labels: string[]; live: LiveState | null; snippet: string | null }
export interface SessionService {
  list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
  get(source: Source, id: string): Session | null;
  getByPk(pk: string): Session | null;
  events(source: Source, id: string, opts: { agentId?: string | null; afterSeq?: number; limit?: number }): { items: TimelineEvent[]; nextSeq: number | null };
  agents(source: Source, id: string): AgentNode[];
  setLive(pk: string, live: LiveState | null): void;      // emits session.updated
  resume(source: Source, id: string, opts: { mode: 'embedded' | 'external'; fork?: boolean; popOut?: boolean; cols?: number; rows?: number }): Promise<{ ptyId: string } | { launched: 'external'; command: string }>;
}
export const sessionPk = (source: Source, id: string) => `${source}:${id}`;

// P1 — apps/daemon/src/services/user-meta.ts (as-built; not anticipated by the original plan)
export interface UserMetaService {
  setPinned(pk: string, pinned: boolean): boolean;
  setLabels(pk: string, labels: string[]): string[];
  labels(): string[];
  views(): SavedView[];
  saveView(i: { name: string; query: Record<string, string> }): SavedView;
  deleteView(id: string): boolean;
}

// P1 — apps/daemon/src/services/external.ts (as-built home for the resume/launch external-process helpers; §13's `shellQuote`/`resumeCommandLine` entries point here)
export type ExternalLauncher = (i: { cwd: string; command: string; args: string[]; openIn: 'vscode' | 'terminal' | 'finder' }) => Promise<void>;
export function createExternalLauncher(run?: CommandRunner): ExternalLauncher

// P1 — apps/daemon/src/indexer/indexer.ts (as-built; not in the original §11 draft)
export interface Indexer {
  scanAll(): Promise<{ files: number; sessions: number; ms: number }>;
  indexFile(path: string): Promise<void>;
  watch(): Promise<void>;
  close(): Promise<void>;
  unknownTypes(): Record<string, number>;
  reconcile(): Promise<{ swept: number; skipped: number }>;   // periodic reconciliation backstop against a dropped chokidar event, see Task 10's "Flake fix"
}
export function createIndexer(deps: { db: OrcDb; raw: Database.Database; paths: OrcPaths; projects: ProjectServiceImpl; bus: EventBus; log: Logger; debounceMs?: number; reconcileMs?: number }): Indexer

// P1 — apps/daemon/src/context.ts (as-built)
export function buildContext(o: { paths: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; isPidAlive?: (pid: number) => boolean }): { ctx: DaemonContext; raw: Database.Database; saveConfig(cfg: OrcConfig): void; close(): void }

// P1 — apps/daemon/src/main.ts (as-built)
export const DEFAULT_WEB_DIST: string;   // apps/web/dist, resolved relative to the daemon package; serveStatic mounts it at '/' iff it exists and o.webDist isn't explicitly overridden
export interface Daemon { ctx: DaemonContext; indexer: Indexer; token: string; start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }> }
export function createDaemon(o?: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null; phase6?: Phase6Options }): Promise<Daemon>   // phase6: P6 test overrides; production passes none

// P1 — apps/daemon/src/services/projects.ts (as-built)
/** Partial<ProjectConfig> is assignable; `features` is itself Partial for PATCH semantics. */
export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & { features?: Partial<ProjectConfig['features']> };
export interface ProjectService { list(): Project[]; resolve(cwd: string): string | null; get(id: string): ProjectConfig | null; update(id: string, patch: ProjectUpdate): ProjectConfig }
export interface ProjectServiceImpl extends ProjectService {
  ensureDefaults(): void;
  ensureDetected(): { added: string[] };
  deriveConfigFor(cwd: string | null): DeriveConfig;
  syncTable(): void;
}   // DaemonContext.projects is typed as ProjectServiceImpl, not the narrower ProjectService — the indexer and other P1-internal callers need the extra methods

// P2 — apps/daemon/src/inbox/dedupe-key.ts
// REVISED in task 9 (was: callers passed a literal `dedupeKey: string`). The unique index is on
// the literal key string, not on (session, kind), so under the old shape a session was only scoped
// because a caller remembered to put it in the key. Two sessions that shared a hand-written key
// silently suppressed each other's items and the user never saw the second one. The engine now
// owns composition and there is no field through which a caller can supply a key.
// Each variant is `Exclusive<…>`: every field of every OTHER variant is re-declared `?: never`,
// so `{ session, project }` is a type error rather than a silently-dropped field.
export type InboxScope =
  | { session: string }             // session pk, `${source}:${id}`
  | { project: string }             // project id
  | { ticket: string }              // ticket key
  | { domain: string; id: string }  // any other namespaced thing: pr, worktree, quota, automation-run, …
  | { global: true };               // one item for the whole daemon (use `facet` for more than one)
export interface InboxKey { kind: InboxKind; scope: InboxScope; facet?: string }
export function inboxDedupeKey(key: InboxKey): InboxItem['dedupeKey']
// `${kind}:${enc(tag)}[:${enc(id)}][:${enc(facet)}]` where `enc` is encodeURIComponent, e.g.
// `waiting:session:claude%3As-basic`, `budget:project:wakecap`, `reminder:global:daily`,
// `pr_event:pr:o%2Fr%234:checks`. `kind` is a closed enum and encoding escapes the `:` separator,
// so the mapping identity → string is injective: nothing can collide, not a pk containing a colon
// nor a domain containing one. `session`/`project`/`ticket` are sugar for the domains of the same
// name — `{domain:'session', id:pk}` is the same key as `{session:pk}`, which is aliasing of ONE
// identity, not a collision of two. `facet` is the extra discriminator for one kind raising
// several distinct items for one scope (a PR's `checks` vs its `review`); it can only ever split
// a key in two, never merge two scopes, and `facet: ''` splits like any other value.

// P2 — apps/daemon/src/inbox/engine.ts
export const REASON_MAX = 300
export interface InboxUpsert extends InboxKey { sessionId?: string | null; projectId?: string | null; ticket?: string | null; reason: string; payload?: Record<string, unknown> }
export interface InboxEngine {
  upsert(item: InboxUpsert): InboxItem;                // open or refresh; emits inbox.upserted; triggers notifier
  resolve(key: InboxKey): void;                        // auto_resolved
  list(filter: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }): InboxItem[];
  markDone(id: string): InboxItem; snooze(id: string, until: string): InboxItem; reopen(id: string): InboxItem;
  registerRule(rule: InboxRule): void;
}
export interface InboxRule { name: string; on: BusEvent['type'][]; handle(e: BusEvent, ctx: DaemonContext): void }
export interface InboxEngineRuntime extends InboxEngine { tick(now?: Date): void; start(intervalMs?: number): void; stop(): void }
export class InboxError extends Error { readonly status: 400 | 404; readonly code: 'not_found' | 'validation_failed' }
export function createInboxEngine(ctx: DaemonContext, opts?: { now?: () => Date; notifier?: Notifier }): InboxEngineRuntime
// `InboxItem.dedupeKey` (§ above) is unchanged — it is a DB column and the wire shape keeps it.
// `reason` is redacted and THEN truncated to REASON_MAX via core's `truncate` (never `slice`, and
// never truncate-first: cutting `PGPASSWORD=hunter2` to `SSWORD=hunter2` removes the anchor every
// pattern matches on). Tasks 10+ call `inboxDedupeKey` instead of declaring their own key helper.
// `upsert` refresh semantics: `undefined`/absent leaves a column alone, any other value — `null`
// included — replaces it, for `payload`, `ticket`, `projectId` and `sessionId` alike. A payload
// that cannot be JSON-serialized is degraded per key and flagged `{ serializationFailed: true }`
// rather than throwing, because a throw inside a rule is swallowed and the item never appears.
// `snooze(until)` takes a future ISO instant with a four-digit year and an explicit zone; a naive
// local time or an expanded year (`+010000-…`, which sorts before every digit in SQL) is a 400.
// P4 inbox rules and keys (registered by wirePhase4, not registerDefaultRules). Every caller passes
// { kind, scope, facet? }; there are no prKey/planKey helpers.
//   pr-event (inbox/rules/pr-event.ts, on pr.changed and pr.reviewRequested), kind 'pr_event', scope { domain: 'pr', id: `${repo}#${n}` }:
//     facet 'checks'            opened when checks becomes 'failure', resolved on 'success'/'pending'
//     facet 'review'            opened on 'changes_requested', resolved on any other review state or when the PR closes/merges
//     facet 'review_requested'  on pr.reviewRequested; resolved when active is false
//   worktree auto-archive (services/worktree/auto-archive.ts), kind 'pr_event', scope { domain: 'worktree', id: path }, facet 'archive_blocked'
//     raised when a merged PR's worktree is dirty or external
//   plan-approval (inbox/rules/plan-approval.ts, on session.statusChanged; finds a pending ExitPlanMode and emits plan.pending),
//     kind 'plan_approval', scope { session: pk }; resolved when the status leaves 'waiting' or after approve/reject
// P5 inbox keys (every caller passes { kind, scope, facet? }):
//   budget alerts (services/usage/budgets.ts budgetInboxKey): kind 'budget', scope { project } | { ticket } | { global: true }, facet `${period}:${periodStart day}:${'warn'|'over'}`
//   quota alerts (services/usage/meter.ts quotaAlertKeys): kind 'budget', scope { domain: 'quota', id: 'block' } facet block start, or { domain: 'quota', id: 'week' } facet week key;
//     the block alert opens at pctOfLimit >= limits.warnPct or when projected exhaustion is within 60 min
//   recap monthly budget (services/recap/recap.ts): kind 'budget', scope { domain: 'recap-budget', id: <month> }
//   reminders (services/reminders/reminders.ts): kind 'reminder', scope { domain: 'reminder', id: <reminder id> }
// The stored keys are therefore e.g. `pr_event:pr:o%2Fr%234:checks`, `pr_event:worktree:<enc path>:archive_blocked`, `plan_approval:session:claude%3A<id>`.

// P2 — apps/daemon/src/notify/notifier.ts
export type NotifyChannel = 'macos' | 'webpush' | 'slack_dm';
export interface NotifyChannelImpl { id: NotifyChannel; send(item: InboxItem, url: string): Promise<void> }
export interface Notifier { notify(item: InboxItem): Promise<void>; register(channel: NotifyChannelImpl): void; setAway(away: boolean): void; isAway(): boolean }
// Every session-scoped inbox item's payload carries `{ source, id }`, so a channel builds its URL as
// `http://127.0.0.1:<port>/sessions/<source>/<id>` without parsing the dedupe key. A banner's text is
// the kind's fixed title plus `item.reason`, which the engine already redacted; no other field goes
// out. `ORC_NOTIFY=off` (§3) registers no channel at all.

// P2 — apps/daemon/src/services/templates.ts
export interface Template { id: string; kind: 'workflow' | 'preset'; label: string; prompt: string; vars: Array<'ticket' | 'ticketUrl' | 'prUrl' | 'file' | 'check'>; defaultSource: Source; projectIds: string[] | 'all' }
export interface TemplateRegistry { list(projectId?: string): Template[]; render(id: string, vars: Record<string, string>): string }
// api-contract
export const LaunchRequest = z.object({ source: z.enum(['claude','codex']), projectId: z.string().nullable(), cwd: z.string(), prompt: z.string().default(''), templateId: z.string().optional(), vars: z.record(z.string(), z.string()).default({}), ticket: z.string().optional(), model: z.string().optional(), planApproval: z.boolean().default(false), worktree: z.object({ repo: z.string(), base: z.string(), type: z.enum(['feat','fix','chore','docs','refactor']), slug: z.string() }).optional(), compare: z.array(z.object({ source: z.enum(['claude','codex']), model: z.string().optional() })).optional() });

// P2 — apps/daemon/src/services/archive/archive.ts
export interface ArchiveService { syncAll(): Promise<{ copied: number }>; status(): { enabled: boolean; files: number; bytes: number; oldestTranscript: string | null; cleanupPeriodDays: number | null }; restore(source: Source, id: string): Promise<void> }
// apps/daemon/src/services/archive/compress.ts
export type ArchiveCodec = 'zstd' | 'gzip'   // zstd when node:zlib has it, else gzip
export interface ArchiveServiceRuntime extends ArchiveService { restorePlan(source: Source, id: string): { targets: string[] }; codec(): ArchiveCodec; start(intervalMs?: number): void; stop(): Promise<void> }
export class ArchiveError extends Error { readonly status: 400 | 404 | 409; readonly code: string; readonly details?: unknown }
export function resolveAvailability(i: { transcriptExists: boolean; archived: boolean; hasPrompts: boolean; remote?: boolean }): Availability
// remote > transcriptExists ('resumable') > archived > 'prompts-only'. SessionService's availability
// expression calls this, so `archived` has exactly one definition.

// P2 — apps/daemon/src/live/live-tracker.ts
export interface HookEvent { sessionId: string; event: string; message: string | null; ts: string }
export interface LiveTracker { start(): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>; list(): Session[]; get(pk: string): Session | null; waitForPid(pid: number, timeoutMs: number): Promise<string | null>; applyHook(e: HookEvent): void }
export function createLiveTracker(ctx: DaemonContext, deps: LiveTrackerDeps): LiveTracker

// P2 — apps/daemon/src/collectors/codex/live.ts
export interface CodexLiveProc { pid: number; cwd: string; startedAtMs: number; rolloutPath: string | null; sessionId: string | null; originator: string | null; lastWriteMs: number | null }
export interface CodexLiveDetector { scan(): Promise<CodexLiveProc[]> }

// P2 — apps/daemon/src/services/launch.ts
export interface LaunchResult { ptyId: string; sessionId: string | null }
export interface LaunchService { launch(req: LaunchRequest): Promise<LaunchResult>; kill(source: Source, id: string): Promise<{ killed: 'pty' | 'pid' }>; ownedCount(projectId: string | null): number }
export class LaunchError extends Error { readonly status: 400 | 404 | 409 | 429 | 501 | 503; readonly code: string; readonly details?: unknown }
export function buildLaunchCommand(cfg: OrcConfig, req: { source: 'claude' | 'codex'; model?: string; prompt: string }): { command: string; args: string[] }
// argv only, never a shell. The prompt is one argv element, always last, and is dropped when blank.
// Codex gets `--` before it (clap reads everything after `--` as the positional); claude gets no
// `--` (Commander dispatches a subcommand even after one), so a prompt equal to one of
// `CLAUDE_SUBCOMMANDS` is a 400 instead. The cap check and the spawn sit in one synchronous block:
// no await between them, or two concurrent launches both pass. Both the cap's limit and its count
// come from the project the CWD resolves to; a request-supplied projectId only has to agree.

// P3 — apps/daemon/src/services/audit/audit.ts
export interface AuditListFilter { sessionPk?: string; action?: string /* exact, or 'area.*' */; actor?: AuditActor; from?: string; to?: string; limit?: number; q?: string; projectId?: string }
export interface AuditService { record(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry; list(filter: AuditListFilter): AuditEntry[] }
export async function audited<T>(audit: AuditService, meta: Omit<AuditEntry, 'id' | 'ts' | 'result' | 'error'>, fn: () => Promise<T>): Promise<T>   // records ok/error; 'denied' when fn throws DeniedError
export class DeniedError extends Error { readonly verdict: DenyVerdict }
export function createAuditService(opts: { db: OrcDb; bus?: EventBus; now?: () => Date }): AuditService
// P3 — apps/daemon/src/http/audit-middleware.ts
export interface AuditedRoute { method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'; pattern: RegExp; action: string | ((body: Record<string, unknown>) => string); target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null; before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown>; recordedBy?: 'service' /* P4 */ }
// P4: every Phase 4 write route is in AUDITED_ROUTES with recordedBy: 'service' (its service records the row through runAudited). The middleware runs the
// handler inside withAuditScope and writes its own row only when the request failed (status >= 400) before the service recorded that action — bad body,
// unknown path, ownership check. POST /api/worktrees/discover is in NON_ACTION_ROUTES (read-only git).
export async function withAuditScope(fn: () => Promise<void>): Promise<Set<string>>   // services/audit/audit.ts; AsyncLocalStorage set of the actions audited() recorded inside fn
export const AUDITED_ROUTES: AuditedRoute[]
export const NON_ACTION_ROUTES: Array<{ method: string; path: string; why: string }>   // pin, label, views, inbox actions, notification prefs, project PATCH, hooks ingest, deny-check;
//   P5: budgets PUT/DELETE, usage/official, settings PUT, streams refresh/link/unlink, analytics digest POST, recaps session/daily POST,
//   goals PUT, reminders POST and cancel, handoffs session POST — each with its reason. P5 audited: handoffs resume-fresh (session.launch), hooks install (hook.install).
export function auditMiddleware(ctx: DaemonContext): MiddlewareHandler   // mounted on /api/* in createApp right after the token middleware
// P3 — apps/daemon/src/pty/audited-pty.ts
export function withPtyInputAudit(pty: PtyManager, audit: AuditService, opts?: { idleMs?: number; actor?: AuditActor }): PtyManager & { flushAll(): void }   // wired in buildContext
// route registration (P1 pattern): registerAuditRoutes, registerSafetyRoutes, registerSessionDetailRoutes, registerLinksRoutes, registerExportRoutes — each (app: OrcApp, ctx: DaemonContext, …).
// The session-detail, links and export services are built inside their register*Routes functions (links and export build theirs lazily on first request), not in buildContext and not on DaemonContext.

// P3 — packages/core/src/derive/deny-list.ts  (pure) + apps/daemon/src/services/safety/deny-list.ts
export interface DenyVerdict { denied: boolean; reason: string | null }
export function checkDenied(text: string, patterns: string[]): DenyVerdict
export const DEFAULT_DENY_PATTERNS: string[]   // prod skills, kubectl prod ctx, terraform apply, git push --force, git reset --hard, rm -rf, DROP TABLE, deploy
export interface DenyList { check(text: string, projectId: string | null): DenyVerdict }
export function createDenyList(deps: { config: () => OrcConfig; projects: Pick<ProjectService, 'get'> }): DenyList   // DEFAULT_DENY_PATTERNS + safety.extraDenyPatterns + the project's prodPatterns
```

**A new write route must be added to `AUDITED_ROUTES` or `NON_ACTION_ROUTES` (enforced by `audit.coverage.test.ts`).**

```ts

// P4 — apps/daemon/src/services/worktree/worktree.ts (as built)
export interface CreateWorktreeInput { repo: string; base: string; type: 'feat'|'fix'|'chore'|'docs'|'refactor'; ticket: string | null; slug: string }
export interface SyncPreviewResult { path: string; mainPath: string; files: string[]; mainDirty: string[] }
export interface WorktreeService {
  discover(): Promise<Worktree[]>; create(i: CreateWorktreeInput): Promise<Worktree>; runScript(path: string, which: 'setup'|'run'|'archive'): Promise<{ ptyId: string }>; syncToMain(path: string): Promise<{ files: number }>; archive(path: string): Promise<void>; branchName(i: Pick<CreateWorktreeInput,'type'|'ticket'|'slug'>): string;   // the original §11 members
  list(filter?: { projectId?: string; state?: Worktree['state']; repo?: string }): WorktreeView[];
  get(path: string): WorktreeView | null;
  findByCwd(cwd: string): WorktreeView | null;               // longest path prefix, active only
  syncPreview(path: string): Promise<SyncPreviewResult>;
  archiveAs(path: string, actor: AuditActor, opts?: { allowExternal?: boolean }): Promise<void>;  // archive(path) = archiveAs(path, 'user', { allowExternal: false })
  createWith(i: CreateWorktreeInput, opts: { runSetup: boolean; actor: AuditActor }): Promise<{ view: WorktreeView; setupPtyId: string | null }>;  // create(i) = createWith(i, { runSetup: true, actor: 'user' }).view
  open(path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void>;
}
export function createWorktreeService(ctx: DaemonContext, opts?: { now?: () => Date; claudeJson?: string; opener?: WorktreeDeps['opener'] }): WorktreeService
// P4 — services/checkpoint/checkpoint.ts (list/create/rewind return CheckpointRecord, a superset of the §11 draft's Checkpoint)
export interface CheckpointService {
  create(sessionPk: string, worktreePath: string, turn: number): Promise<CheckpointRecord>;
  list(sessionPk: string): CheckpointRecord[];
  rewind(checkpointId: string): Promise<CheckpointRecord /* safety checkpoint */>;
  diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string /* unified diff */>;
  get(id: string): CheckpointRecord | null;
  createAs(sessionPk: string, worktreePath: string, turn: number, kind: CheckpointRecord['kind'], actor: AuditActor): Promise<CheckpointRecord>;
  pruneForWorktree(worktreePath: string): Promise<number>;
}
// services/checkpoint/turn-hook.ts: registerCheckpointHook(ctx) → stop(); a 'turn' checkpoint on session.turnEnded for an owned session whose cwd is an active worktree.
// P4 — services/ship/ship.ts
export interface ShipSuggestionResult { message: string; title: string; body: string; base: string; branch: string; ticket: string | null }
export interface ShipService {
  commit(cwd: string, message: string): Promise<{ sha: string }>; push(cwd: string): Promise<void>; createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef>; merge(pr: PrRef, method: 'merge'|'squash'|'rebase'): Promise<void>;
  suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult>;
  backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }>;
}
// P4 — connectors/github/github.ts (PrStatus is the §4 core type, re-exported here)
export interface GithubConnector {
  status(): Promise<'ok'|'unauthenticated'|'error'>;   // GET /api/github/status adds 'disabled' when config.github.enabled is false
  prStatus(pr: PrRef): Promise<PrStatus>; myOpenPrs(): Promise<PrStatus[]>; poll(): Promise<void> /* emits pr.changed / pr.reviewRequested */;
  watch(pr: PrRef): void;                    // add a PR to the poll set (after create/merge)
  start(): () => void;                       // poll now and every cfg.github.pollSeconds; returns stop()
}
// P4 — services/diff/diff.ts
export interface DiffService {
  diff(cwd: string, opts?: { from?: string; to?: string | 'WORKTREE' }): Promise<DiffResult>;
  mergeBase(cwd: string): Promise<string>;
  revert(cwd: string, file: string, opts: { hunkIndex?: number; from?: string }): Promise<{ reverted: string }>;   // safety commit at refs/orchestrator/reverts/<epochMs>
}
// P4 — services/review/review.ts
export interface ReviewService {
  summary(source: Source, id: string): Promise<ReviewSummary>;
  sendComments(source: Source, id: string, comments: ReviewComment[], deliver: 'session' | 'text'): Promise<{ sent: boolean; text: string }>;   // sends only to owned sessions (isOwned), otherwise sent: false
}
// P4 — services/review/plan-approval.ts ; plan-keys.ts holds PLAN_KEYS (the TUI keystrokes for approve/reject; not yet confirmed on the real TUI)
export interface PlanApprovalService { approve(pk: string): Promise<void>; reject(pk: string, feedback: string): Promise<void> }
// P4 — services/git/exec.ts: git/gh wrappers; assertSafeGitArgs throws GitError('forbidden_git_args') on force pushes, ref-deletion pushes, hard resets,
//   git clean, forced worktree removal, `checkout -- <paths>`, branch deletion, any stash write and update-ref outside refs/orchestrator/.
// P4 — services/git/audit.ts: runAudited(ctx, actor, action, target, params, fn) = audited(ctx.audit, …); every P4 git/gh/PTY write goes through it.
// P4 — launch (P2's services/launch.ts keeps LaunchService; there is no services/launch/ folder)
export function prepareLaunch(ctx: DaemonContext, req: LaunchRequest): Promise<LaunchRequest>   // services/launch-prepare.ts: 400 for planApproval on Codex; for req.worktree creates the worktree, waits for setup, moves cwd into it and drops the field
export function applyPlanMode(args: string[]): string[]   // services/launch-plan-mode.ts: drops every permission-mode switch and appends `--permission-mode plan`
// P4 — apps/daemon/src/main.ts
export function wirePhase4(ctx: DaemonContext, opts?: { startPollers?: boolean }): () => void
// Sets ctx.worktrees, checkpoints, diff, review, github, ship, plans; registers prEventRule and the plan-approval rule on ctx.inbox, the checkpoint turn hook and the
// PR-merge auto-archive (services/worktree/auto-archive.ts); with startPollers (default true) runs discovery now and every 5 minutes and starts the GitHub poller only
// when config.github.enabled.
// DaemonContext additions (P4): diff?: DiffService; review?: ReviewService; plans?: PlanApprovalService; worktrees/checkpoints/ship/github as above.
// bus additions (P4): pr.changed, plan.pending, pr.reviewRequested (§6).

// P5 (as built) — services/usage/meter.ts, ledger.ts, budgets.ts
export interface UsageMeter {
  snapshot(): UsageSnapshot; checkBudget(scope: { projectId?: string; ticket?: string }): BudgetCheck;
  refresh(now?: Date): UsageSnapshot;                        // recompute; emits usage.updated only when changed
  ingestOfficial(raw: unknown): OfficialQuotaSample | null;  // null unless limits.quotaSource === 'official'
  budgets(now?: Date): BudgetStatus[]; contextFill(sessionPk: string): ContextFillInfo | null; concurrency(): ConcurrencyStatus[];
  start(): void; stop(): void;
}
export function quotaAlertKeys(s: UsageSnapshot, warnPct: number): Array<{ key: InboxKey; reason: string }>
export interface UsageLedger {
  syncSession(sessionPk: string): Promise<{ added: number }>; backfill(sinceIso: string): Promise<{ sessions: number }>;
  entries(q: LedgerQuery): LedgerEntry[]; tools(q: Omit<LedgerQuery, 'ticket'>): LedgerTool[]; sumCost(q: LedgerQuery): number;
  latestMainUsage(sessionPk: string): { model: string; usage: Usage } | null; start(): void; stop(): void;
}   // LedgerQuery = { from; to; projectId?; ticket? }
// budgets.ts: periodStart, configBudgets, allBudgets (table wins over config), evaluateBudgets, checkBudgetScope, budgetAlertLevel, budgetInboxKey, raiseBudgetAlerts
// P5 — services/recap/{recap,engines}.ts ; services/handoff/handoff.ts ; services/goals/goals.ts ; services/reminders/reminders.ts
export interface RecapService {
  recap(sessionPk: string, opts?: { onDemand?: boolean }): Promise<{ text: string; costUsd: number; model: string; cached: boolean }>;
  daily(projectId: string, date: string): Promise<string>;
  latest(sessionPk: string): Recap | null; latestDaily(projectId: string, date: string): Recap | null;
  findCached(kind: RecapKind, targetKey: string, offset: number): Recap | null;
  runLlm(kind: RecapKind, targetKey: string, offset: number, prompt: string, opts: { onDemand: boolean; approxTokens: number }): Promise<Recap>;
  monthSpend(now?: Date): { spentUsd: number; budgetUsd: number };
  syncSchedule(): void; start(): void; stop(): void;
}
export interface RecapEngine { id: RecapEngineId; run(prompt: string, opts: { model: string; maxBudgetUsd: number; timeoutMs?: number }): Promise<{ text: string; costUsd: number; model: string; engine: RecapEngineId }> }
export class RecapEngineError extends Error { readonly code: 'engine_failed' | 'engine_unavailable' | 'bad_output' }
export function defaultRecapEngines(ctx: DaemonContext): Record<RecapEngineId, RecapEngine>   // createClaudeCliEngine (`claude -p … --output-format json`), createAnthropicApiEngine (@anthropic-ai/sdk)
export interface HandoffService {
  generate(sessionPk: string): Promise<Handoff>; toMarkdown(h: Handoff): string; latest(sessionPk: string): Handoff | null;
  get(id: string): Handoff | null; resumeFresh(handoffId: string): Promise<{ ptyId: string }>;
}   // the P3 export ZIP writes latest(pk) as handoff.md, redacted with the rest of the bundle
export interface GoalService {
  get(targetType: Goal['targetType'], targetId: string): Goal | null; set(g: Omit<Goal, 'id' | 'updatedAt'>): Goal;
  list(filter: { state?: GoalState[] }): Goal[]; prefill(targetType: Goal['targetType'], targetId: string): string;
  sweep(now?: Date): number; start(): void; stop(): void;
}   // rules: PR merged → complete; waiting > WAITING_BLOCK_MS (30 min) → blocked with NEEDS_ANSWER
export interface CreateReminderInput { sessionPk: string | null; ticket: string | null; text: string; dueAt: string; sendToSession: boolean }
export interface ReminderService { create(i: CreateReminderInput): Reminder; list(f: { state?: ReminderState[]; sessionPk?: string }): Reminder[]; cancel(id: string): Reminder; fire(reminderId: string): Promise<void>; start(): void }
// P5 — services/scheduler/scheduler.ts (croner, persisted in scheduled_jobs; one-shot jobs fire at most once)
export interface ScheduledJob { id: string; kind: 'reminder' | 'automation' | 'digest'; cron: string | null; runAt: string | null; payload: Record<string, unknown>; enabled: boolean }
export interface Scheduler {
  add(job: Omit<ScheduledJob, 'id'>): ScheduledJob; remove(id: string): void; list(kind?: ScheduledJob['kind']): ScheduledJob[];
  onFire(kind: ScheduledJob['kind'], fn: (job: ScheduledJob) => Promise<void>): void; get(id: string): ScheduledJob | null; start(): void; stop(): void;
}
export function createScheduler(opts: { db: OrcDb; log: Logger; now?: () => Date }): Scheduler
export function ensureCronJob(s: Scheduler, kind: ScheduledJob['kind'], type: string, cron: string, extra?: Record<string, unknown>): ScheduledJob
export function removeJobsOfType(s: Scheduler, kind: ScheduledJob['kind'], type: string): number
// P5 — services/streams/streams.ts, services/pr-source.ts, services/wstack.ts
export interface StreamService {
  refresh(): Promise<WorkStream[]>; refreshIfStale(): Promise<void>;   // stale after 30 s; also rebuilt every 120 s, on pr.changed (marks stale) and on index.initialComplete
  list(q: { projectId?: string; stage?: StreamStage }): WorkStream[]; get(ticket: string): Promise<StreamDetail | null>;
  link(ticket: string, kind: StreamLinkKind, ref: string): StreamLink; unlink(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  start(): void; stop(): void;
}
export interface PrSource { list(): StreamPr[] }   // reads the P4 pr_cache; toStreamPr(p: PrStatus): StreamPr
export function resolveWstackHome(env?: NodeJS.ProcessEnv): string   // WSTACK_HOME ?? ~/.wstack
export function readWstackWorkflows(home: string): StreamWorkflowInput[]; export function readWstackTimelines(home: string): unknown[]
// P5 — services/analytics/{analytics,digest,facets}.ts
export interface AnalyticsQuery { from: string; to: string; projectId?: string }
export interface AnalyticsService {
  cost(q: AnalyticsQuery & { groupBy: AnalyticsGroupBy }): { rows: CostRow[]; estimated: boolean };
  top(q: AnalyticsQuery & { limit: number }): TopResult; tools(q: AnalyticsQuery & { bucket: 'day' | 'week' }): ToolUsageRow[];
  timing(q: AnalyticsQuery & { bucket: 'day' | 'week' }): TimingResult; outcomes(q: AnalyticsQuery): OutcomesResult; wstack(q: AnalyticsQuery): WstackSkillRow[];
}
export interface DigestService { generate(weekStart?: string): Promise<DigestRecord>; latest(): DigestRecord | null; syncSchedule(): void; start(): void; stop(): void }
// P5 — services/hooks/install.ts and src/bin/orc-statusline.ts
export function shellQuote(s: string): string   // single-argument quoting for the hook command (not P1's shellQuote(parts[]))
export function buildHookCommand(o: { tokenFile: string; port: number }): string
export function hookSettingsFragment(command: string): { hooks: Record<string, HookEntry[]> }
export function mergeHookSettings(settings: Record<string, unknown>, command: string): Record<string, unknown>   // idempotent; keeps foreign hooks
export function isHookInstalled(settings: unknown): boolean; export function hookInstallStatus(ctx: DaemonContext): HookInstallStatus
export function installHooks(ctx: DaemonContext, now?: () => Date): { settingsPath: string; backupPath: string | null }   // backup under $ORC_HOME/backups
export function statuslineCommand(): string; export function statuslineSnippet(): string   // shown only; the app never writes statusLine
// P2 changes made by P5: HookEvent gains `tool?: string | null`; mapHookToStatus (live/live-tracker.ts) delegates to hookStatusFor; POST /api/hooks maps bodies with pickHookFields/mapHookPayload; LiveTracker's hook precedence uses hookWins(…, hooks.statusOverrideMs).
// P5 — apps/daemon/src/main.ts: createDaemon().start() starts digests, recaps, goals, reminders, scheduler, ledger, usage and streams (in that order, so handlers exist before overdue jobs fire),
//   then emits index.initialComplete after the first scanAll.

// P6 (as built) — packages/api-contract/src/routes/connectors.ts ; re-exported as a type from connectors/linear/linear.ts
export interface LinearIssue { id: string; identifier: string; title: string; state: string; assignee: string | null; url: string; labels: string[] }
// P6 — connectors/linear/linear.ts ; connectors/slack/slack.ts (injectable API adapters in connectors/{linear,slack}/api.ts; errors are ConnectorError from connectors/errors.ts)
export interface LinearConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; issue(identifier: string): Promise<LinearIssue | null>; comment(identifier: string, markdown: string): Promise<void>; createIssue(i: { teamKey: string; title: string; description: string; assignToMe?: boolean }): Promise<LinearIssue>; assignedToMe(): Promise<LinearIssue[]>; me(): Promise<LinearViewer>; invalidate(): void }
export function createLinearConnector(d: { secrets: SecretStore; api?: (token: string) => LinearApi; cacheTtlMs?: number; now?: () => number }): LinearConnector
export interface SlackReply { ts: string; user: string; text: string; botId: string | null; appId: string | null }
export interface SlackConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; me(): Promise<{ userId: string; dmChannelId: string; label: string }>; post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>; replies(channel: string, threadTs: string, afterTs?: string): Promise<SlackReply[]>; mentions(sinceTs: string): Promise<Array<{ channel: string; ts: string; text: string }>>; reactions(channel: string, ts: string): Promise<string[]>; nudge(text: string): Promise<void>; invalidate(): void }
export function createSlackConnector(d: { secrets: SecretStore; api?: (token: string | null) => SlackApi; now?: () => number }): SlackConnector
// P6 — connectors/linear/assigned-poller.ts ; connectors/slack/mention-poller.ts ; connectors/stream-enricher.ts (all started by createPhase6().start())
export interface PollerHandle { tick(): Promise<void>; start(): void; stop(): void }
export function createLinearAssignedPoller(d: { ctx: DaemonContext; linear: LinearConnector; now?: () => Date }): PollerHandle   // emits linear.issueChanged; cursor in connector_tokens_meta.cursor_json
export function createSlackMentionPoller(d: { ctx: DaemonContext; slack: SlackConnector; now?: () => Date }): PollerHandle      // emits slack.mention (redacted)
// P6 — services/secrets/secret-store.ts (@napi-rs/keyring, service "orchestrator"; the account is the key)
export interface SecretStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export type SecretKey = `${'linear' | 'slack'}.${'token' | 'client_id' | 'client_secret' | 'refresh_token'}`;
export function createSecretStore(service?: string): SecretStore
export function createMemorySecretStore(initial?: Record<string, string>): SecretStore & { dump(): Record<string, string> }
// P6 — http/p6-util.ts ; services/share/share.ts
export interface Who { actor: AuditActor; actorDetail: string | null }
export type ShareSource = { kind: 'recap'; sessionPk: string } | { kind: 'handoff'; sessionPk: string } | { kind: 'plan'; planPath: string } | { kind: 'daily'; projectId: string; date: string } | { kind: 'text'; text: string };   // zod in routes/connectors.ts
export interface ShareService { compose(src: ShareSource): Promise<string>; commentOnLinear(identifier: string, body: string, who: Who): Promise<void>; createFollowUp(i: { sessionPk: string; teamKey: string; title: string; description: string; includeRecap: boolean }, who: Who): Promise<LinearIssue>; postToSlack(channel: string, text: string, who: Who): Promise<{ ts: string }> }   // MAX_SHARE_CHARS = 20_000
// P6 — services/remote/session-actions.ts ; services/remote/slack-bridge.ts
export interface SessionActions { reply(i: { pk: string; text: string } & Who): Promise<void>; approve(i: { itemId: string } & Who): Promise<InboxItem> }
export function inboxSessionPk(item: InboxItem): string | null   // payload { source, id } → composed dedupe key `${kind}:session:${encodeURIComponent(pk)}[:facet]` → plain `<kind>:<pk>` → sessionId
export interface SlackBridge { ensureThread(item: InboxItem, url: string): Promise<void>; onInboxUpserted(item: InboxItem): Promise<void>; poll(): Promise<void>; start(): void; stop(): void }
// P6 — remote/*
export interface DeviceService { create(name: string, login: string | null): { device: RemoteDeviceRow; token: string }; verify(token: string | null | undefined): RemoteDeviceRow | null; get(id: string): RemoteDeviceRow | null; list(): Array<RemoteDeviceRow & { credentials: number }>; revoke(id: string): boolean }
export interface PairingService { create(): { code: string; expiresAt: string }; consume(code: string): boolean; activeUntil(): string | null }   // one active code, single use, 5 wrong tries cancel it
export interface StepUpStore { grant(deviceId: string): string; valid(deviceId: string): boolean; validUntil(deviceId: string): string | null; revoke(deviceId: string): void }
export interface FunnelWatch { detected(): boolean; refresh(): Promise<boolean>; start(): void; stop(): void }
export interface WebAuthnService { registrationOptions(deviceId: string): Promise<PublicKeyCredentialCreationOptionsJSON>; verifyRegistration(deviceId: string, response: RegistrationResponseJSON): Promise<{ credentialId: string }>; stepUpOptions(deviceId: string): Promise<PublicKeyCredentialRequestOptionsJSON>; verifyStepUp(deviceId: string, response: AuthenticationResponseJSON): Promise<{ validUntil: string }> }   // registration open for REGISTRATION_WINDOW_MS (15 min) after pairing
export interface AwayService { state(): AwayState; setMode(mode: AwayMode): Promise<AwayState>; tick(): Promise<AwayState>; start(): void; stop(): void }
// P6 — notify/vapid.ts ; notify/webpush.ts ; notify/slack-dm.ts ; notify/routing.ts
export interface VapidKeys { publicKey: string; privateKey: string; createdAt: string }   // $ORC_HOME/vapid.json via loadOrCreateVapidKeys(orcHome)
export interface WebPushChannel extends NotifyChannelImpl { sendTest(): Promise<number> }   // id 'webpush'
export function createSlackDmChannel(bridge: Pick<SlackBridge, 'ensureThread'>): NotifyChannelImpl   // id 'slack_dm'
export function selectChannels(i: { pref: NotifyPref; away: boolean; awayChannels: NotifyChannel[] }): NotifyChannel[]   // while away: drop macos, add away.channels
// P6 — context.ts ; phase6.ts ; http/app.ts
export interface RemoteAccess { devices: DeviceService; pairing: PairingService; stepUp: StepUpStore; funnel: FunnelWatch; webauthn: WebAuthnService; vapid: VapidKeys; webpush: WebPushChannel }
export interface Phase6Options { secrets?: SecretStore; linearApi?: (token: string) => LinearApi; slackApi?: (token: string | null) => SlackApi; pushSender?: PushSender; idle?: () => Promise<number | null>; run?: RunCommand }
export function createPhase6(ctx: DaemonContext, o?: Phase6Options): Phase6   // builds every P6 service, sets them on ctx, registers the webpush and slack_dm channels (needs ctx.notifier, so it runs after startPhase2)
export interface Phase6 { secrets; linear; slack; share; actions; bridge; away; devices; pairing; stepUp; funnel; webauthn; keys; push; guardDeps: RemoteGuardDeps; start(): void; stop(): void }   // no register hook; start/stop are idempotent and every timer is unref'd
export interface AppOptions { ctx; token; port: () => number; webDist?; env?; remote?: RemoteGuardDeps | null; phase6?: { guardDeps: RemoteGuardDeps } | null }   // remote wins; phase6 only supplies guardDeps as the fallback
export interface RemoteGuardDeps { config: () => OrcConfig; devices: DeviceService; stepUp: StepUpStore; funnel: Pick<FunnelWatch, 'detected'> }
// createDaemon().start(): createPhase6 → createApp({ …, remote: phase6.guardDeps }) → phase6.start() → attachPtyWebSocket({ …, remote: phase6.guardDeps }); close() calls phase6.stop().
```

**P6 error and audit plumbing:**
- `ServiceErrorStatus` is `400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503`; `502` is used for `upstream_error` (Linear or Slack failed), `503` for `unavailable`.
- `apps/daemon/src/services/audit/actor-scope.ts` exports `actorScope: AsyncLocalStorage<{ actor: AuditActor; actorDetail: string | null }>`. P3's `withPtyInputAudit` reads `actorScope.getStore()` before its own `actor` option, so `pty.input` entries for remote replies carry `actor: 'remote'` and the device or `slack_dm` detail.
- **For Phase 7:** `linear.issueChanged` and `slack.mention`, and the pollers in `connectors/linear/assigned-poller.ts` and `connectors/slack/mention-poller.ts`, already exist after Phase 6; Phase 7 consumes them instead of creating them. Their shipped signatures (`{ ctx, linear|slack, now? }` → `PollerHandle`, started by `createPhase6`) differ from the `{ linear, bus, log, intervalMs }` → `Poller` shape the Phase 7 plan sketches; Phase 7 subscribes to the bus events and does not start a second poller.

```ts
// P7 — services/automations ; services/supervisor
export interface AutomationService { list(): Automation[]; save(a: Automation): Automation; runNow(id: string): Promise<AutomationRun>; runs(id: string): AutomationRun[] }
export interface Automation { id: string; name: string; enabled: boolean; trigger: { type: 'cron'; cron: string } | { type: 'github'; event: 'review_comment'|'check_failed'|'pr_merged' } | { type: 'linear'; event: 'assigned'|'labeled'; label?: string } | { type: 'slack'; event: 'mention'; channel: string } | { type: 'manual' }; action: { templateId: string; projectId: string; repo?: string; useWorktree: boolean; headless: boolean; model?: string; timeoutMin: number; planApproval: boolean }; budgetUsd: number }
export interface AutomationRun { id: string; automationId: string; startedAt: string; endedAt: string | null; status: 'queued'|'running'|'awaiting_approval'|'success'|'failed'|'denied'|'over_budget'; sessionPk: string | null; costUsd: number | null; summary: string | null }   // P7: 'awaiting_approval' added
export interface SupervisorDecision { id: string; sessionPk: string; question: string; decision: 'answer'|'escalate'; answer: string | null; confidence: number; reason: string; ts: string }
export interface Supervisor { evaluate(sessionPk: string): Promise<SupervisorDecision>; enabledFor(sessionPk: string): boolean }
```

**P7 as built.** `Automation`, `AutomationRun` and the rest are zod schemas in `@orc/api-contract` (`routes/automations.ts`); the daemon re-exports the types. `ctx.automations` and `ctx.supervisor` hold the implementation types `AutomationServiceImpl` and `SupervisorImpl`, which are supersets of the interfaces above.

```ts
// P7 — apps/daemon/src/phase7.ts
export interface Phase7Options { runner?: HeadlessRunner; addedLines?: (cwd: string, base: string) => Promise<string>; classifier?: Classifier; agnc?: { factory?: AgncClientFactory; secrets?: SecretStore; intervalMs?: number } }
export interface Phase7 { automations; suggestions; compare; supervisor; agnc; start(): void; stop(): void }   // start/stop idempotent
export function createPhase7(ctx: DaemonContext, o?: Phase7Options): Phase7
// Sets ctx.automations/suggestions/compare/supervisor/agnc. Cron schedules and event triggers attach once automations.enabled
// is on (at boot, before ctx.scheduler.start(), or on the first config.changed that turns it on); a fired job starts nothing
// while the switch is off again. start() follows automations.suggestions.enabled, supervisor.enabled and agnc.enabled on every
// config.changed (turning agnc off disconnects). createDaemon({ …, phase7?: Phase7Options }) calls createPhase7 then phase7.start();
// close() calls phase7.stop(). No register hook: routes are in registerAllRoutes.
// apps/daemon/test/fakes/phase7.ts
export function offlinePhase7(): Phase7Options   // every test daemon and the e2e fixture daemon: a runner that writes one line and never
// spawns claude, no git diff, a classifier that always escalates, AGNC on the in-memory fake server with the memory secret store

// P7 — routes/automations.ts (zod)
export type TriggerSource = 'cron' | 'github' | 'linear' | 'slack' | 'manual' | 'rerun';
export interface AutomationRunDetail extends AutomationRun { triggerKey: string; triggerSource: TriggerSource; vars: Record<string, string>; ptyId: string | null; worktreePath: string | null; prUrl: string | null; diffStat: DiffStat | null; error: string | null; rerunOf: string | null }
export interface DiffStat { files: number; insertions: number; deletions: number; untracked: number }   // DiffStatSchema in routes/p7-common.ts; services/git/git-info.ts
export interface RunStats { total; success; failed; successRate: number | null; lastRunAt: string | null; monthSpendUsd: number }
// AutomationWithStats = Automation & { stats: RunStats; nextRunAt: string | null }
// Suggestion { id, source: 'linear'|'todo', projectId, title, detail, ticket, file, line, state: 'new'|'accepted'|'dismissed', createdAt, … }

// P7 — services/automations/service.ts
export interface TriggerFire { key: string; source: TriggerSource; vars: Record<string, string>; rerunOf?: string | null }
export interface AutomationServiceImpl extends AutomationService {
  get(id: string): Automation | null; listWithStats(): AutomationWithStats[]; getWithStats(id: string): AutomationWithStats | null;
  remove(id: string): void; setEnabled(id: string, enabled: boolean): Automation;
  start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null>;   // null = trigger key already handled
  approve(runId: string): Promise<AutomationRunDetail>; reject(runId: string): AutomationRunDetail; rerun(runId: string): Promise<AutomationRunDetail | null>;
  runs(id: string): AutomationRunDetail[]; run(runId: string): AutomationRunDetail | null; waitFor(runId: string): Promise<AutomationRunDetail>;
  logLines(runId: string): string[]; onChange(fn: (id: string, a: Automation | null) => void): () => void; stop(): void;
}
// services/automations/guardrails.ts: AUTOMATION_ALLOWED_TOOLS, AUTOMATION_DISALLOWED_TOOLS (includes Bash(gh pr merge *), Bash(git push --force *),
//   Bash(kubectl *), Bash(terraform *)), AUTOMATION_DENY_PATTERNS, checkAutomationGuards(i) — master switch, deny-list, budgets, before every run and approval
// services/automations/headless.ts: HeadlessRunner = (o: HeadlessRunOptions) => Promise<HeadlessRunResult>; runHeadless runs
//   `claude -p --output-format stream-json --verbose --permission-prompts none …` with the prompt on stdin and env ORC_AUTOMATION=1
//   (the parent env, including ANTHROPIC_API_KEY, is inherited — see phase-7-evidence.md)

// P7 — services/automations/suggestions.ts
export interface SuggestionService { list(state?: Suggestion['state']): Suggestion[]; get(id: string): Suggestion | null; refresh(): Promise<{ added: number }>; accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>; dismiss(id: string): Suggestion; start(): () => void }

// P7 — services/compare/compare.ts
export interface CompareService { launch(req: LaunchRequest): Promise<CompareGroup>; estimate(projectId: string | null, n: number): CompareEstimate; get(id: string): CompareGroup | null; view(id: string): Promise<CompareView>; pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string }; archiveLosers(id: string): Promise<ArchiveLosersResult> }
// createCompareService returns CompareService & { list(limit?) }. archiveLosers needs a winner (409 invalid_state), kills running losers
// (session.kill), and archives only worktrees the group created through worktrees.archiveAs (dirty and external ones are refused and
// reported per variant; `git worktree remove` keeps the branch).

// P7 — services/supervisor/supervisor.ts
export interface SupervisorImpl {
  evaluate(sessionPk: string): Promise<SupervisorDecisionView>; enabledFor(sessionPk: string): boolean; start(): () => void;
  setTarget(t: SupervisorTarget): SupervisorTarget; targets(): SupervisorTarget[];
  rules(): SupervisorRule[]; addRule(r: SupervisorRuleInput): SupervisorRule; removeRule(id: string): boolean;
  decisions(q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[];
  feedbackWrong(decisionId: string): SupervisorRule; status(): SupervisorStatus;
}
// Sends only canned allow-listed answers to owned sessions (ownership 'owned' and a ptyId). The question is checked against the
// deny-list before the classifier; the canned answer is re-checked against ctx.denyList and SUPERVISOR_DENY_PATTERNS before it is sent.
// A session target wins over a project target. Classifier: services/supervisor/classifier.ts (headless `claude -p`, strict JSON).

// P7 — connectors/agnc/agnc.ts
export interface AgncConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; beginAuth(): Promise<{ authorizationUrl: string | null }>; finishAuth(code: string, state: string): Promise<void>; listMySessions(): Promise<AgncSession[]>; getSession(id: string): Promise<AgncSession | null>; listMessages(id: string): Promise<AgncMessage[]>; listEvents(id: string, cursor?: string): Promise<{ items: AgncEvent[]; nextCursor: string | null }>; sendPrompt(id: string, prompt: string, model?: string): Promise<void>; createSession(i: { repoOwner: string; repoName: string; baseBranch?: string; title?: string; initialPrompt: string; model?: string }): Promise<AgncSession>; disconnect(): Promise<void>; signOut?(): Promise<void> }
// Auth (spike S4 finding): AGNC answers `initialize` without a token, so a successful connect() proves nothing. The connector sends
// client.listTools() after connect() and only then treats the client as live; an UnauthorizedError there, or from a later callTool,
// sets the pending OAuth flow. OAuth client registration and tokens live only in the SecretStore (`agnc.client`, `agnc.tokens`);
// the redirect URL is `http://127.0.0.1:<port>/oauth/agnc/callback`.

// P7 — services/launch/spawn.ts ; services/git/git-info.ts ; http/p7-guard.ts
export function assertOwnedCapacity(ctx: DaemonContext, projectId: string | null, needed?: number): void   // 409 capacity_exceeded
export interface SpawnResult { ptyId: string; sessionId: string | null; sessionPk: string | null; command: string; args: string[] }
export function spawnClaudeSession(ctx, i: { cwd; prompt; model?; args; sessionId? }): SpawnResult   // prompt after `--`
export function spawnCodexSession(ctx, i: { cwd; prompt; model? }): SpawnResult
export function parseShortStat(text): Omit<DiffStat, 'untracked'>; export function diffStat(cwd, base): Promise<DiffStat>; export function addedLinesDiff(cwd, base): Promise<string>
export function defaultBranch(repo): Promise<string>; export function parseRemoteSlug(url): { owner; name } | null; export function remoteSlug(repo): Promise<{ owner; name } | null>
export function requireConfirmed(body: { confirm?: boolean }, summary: string, details?): void   // 409 confirmation_required
export function need<T>(svc: T | undefined, name: string): T                                     // 409 not_enabled
export const ConfirmBody; export const API_BASE = 'http://127.0.0.1:4317'; export const TEST_TOKEN   // test constants

// P7 — notify/stdout-bridge.ts
export const NOTIFY_PREFIX = 'ORC_NOTIFY ';
export function notifyLine(item: InboxItem, url: string): { title: string; body: string; url: string; kind: string }
export function createStdoutNotifyChannel(write?: (line: string) => void): NotifyChannelImpl   // id 'macos'
```

**`orc-mcp` (`apps/mcp`).** A stdio MCP server built on `@modelcontextprotocol/sdk`, a thin read-mostly client of the daemon HTTP API (`daemon-client.ts`, which sends `x-orc-token` and turns API errors into `DaemonError`, reported as tool errors). Tools: `list_live_sessions`, `list_waiting` (attention inbox kinds only), `search_sessions`, `get_session_summary`, `get_stream`, `resume_session` (returns a resume command and a web link; launches only when asked). Registration with Claude and Codex is manual (`claude mcp add --scope user …`).

**Desktop shell (`apps/desktop`).** Tauri 2 app `Orchestrator` (`dev.orchestrator.desktop`). It uses the daemon at `http://127.0.0.1:4317` when one is already running, and otherwise starts the sidecar `orc-node` on `resources/daemon` with `ORC_NOTIFY_BRIDGE=stdout` and `ORC_WEB_DIR=<resources/web>`, turns `ORC_NOTIFY ` stdout lines into native notifications (`bridge.rs`), injects the install token into the window, shows the waiting count and block percentage in the tray, and registers the global hotkey ⌘⇧O.

## 12. Web app conventions
- **Routes** (TanStack Router, file-based under `apps/web/src/routes/`):
  - `/` redirects to `/inbox` from P2 on (`/history` before that)
  - `/history`, `/sessions/$source/$id`, `/live`, `/inbox`, `/worktrees` (P4), `/review/$source/$id` (P4), `/streams` and `/streams/$ticket` (P5), `/analytics` (P5), `/audit` (P3), `/pair` (P6), `/automations` (P7), `/compare/$groupId` (P7), `/settings`
- **Global layout:** `apps/web/src/features/shell/AppShell.tsx`:
  - top bar with the project selector (F13), a search box and the inbox count
  - left nav
  - a resizable bottom/right terminal dock (`features/terminal/TerminalDock.tsx`)
- **Stores:**
  - `stores/project.ts` → `useProjectStore` `{ projectId, setProjectId }`, persisted in localStorage
  - `stores/terminals.ts` → `useTerminalStore` `{ tabs: {ptyId,title}[], active, open(ptyId,title), close(ptyId), setActive(ptyId) }` — `setActive` is a P1 addition over the original draft (switches the focused terminal tab without opening/closing one); persisted to **sessionStorage** (not localStorage — tabs are meant to outlive a reload within the same browser tab, not follow the user across tabs/devices)
  - `stores/live-layout.ts` (P2) → `useLiveLayoutStore` `{ layout: 'grid'|'list'|'split'; pinned: string[]; groupBy: 'none'|'project'|'ticket'|'source'; openInByProject: Record<string, OpenInApp>; setLayout; togglePin; setGroupBy; setOpenIn }`, persisted in localStorage under `orc.live-layout`. `togglePin` keeps the last `MAX_PINNED` (4) pins.
  - `stores/launch.ts` (P2) → `useLaunchStore` `{ open: boolean; preset: Partial<LaunchRequestInput> | null; show(preset?); hide() }` — **not** persisted: a half-filled launch form should never survive a reload.
  - `stores/view-mode.ts` (P3) → `useViewModeStore` `{ mode: 'summary' | 'normal' | 'verbose'; setMode(m) }`, persisted in localStorage under `orc.viewMode`.
  - `stores/palette.ts` (P3) → `usePaletteStore` `{ open: boolean; setOpen(v: boolean); toggle() }`, not persisted.
- **Hotkeys (P3, `features/hotkeys/`):** `registry.ts` → `hotkeys` (singleton `HotkeyRegistry`), `useHotkeys(bindings: HotkeyBinding[], deps: unknown[])`, `formatKeys(keys)`; `HotkeysListener.tsx` → `<HotkeysListener/>`; `GlobalHotkeys.tsx` registers the global shortcuts.
  ```ts
  export interface HotkeyBinding { id: string; keys: string /* 'g i' | 'mod+k' | 'j' */; description: string; group: 'navigation' | 'actions' | 'inbox' | 'session'; handler: () => void; allowInInputs?: boolean }
  ```
  Global shortcuts: `mod+k` palette, `g i` inbox, `g w` waiting, `g h` history, `g a` audit, `n` new session. Inbox `j/k/e/s` stay owned by Phase 2's `useInboxKeys` and register through `useHotkeys`.
- **Session detail route (P3):** `/sessions/$source/$id?tab=timeline|agents|usage|files|links|raw&agent=<agentId>&file=<path>`.
- **API access** only through hooks in `api/queries/*.ts`: `useSessions(filters)`, `useSession(source,id)`, `useSessionEvents(...)`, `useLive()`, `useInbox(filters)`, etc. The WS hook `useLiveEvents()` is mounted once in `AppShell` and applies cache updates.
- **Query keys** are exported next to the hook that owns them, and nothing builds one inline: `['sessions', filters]`, `['session', source, id]`, `['projects']`, `['project', id]`, `['pty']`, `['views']`, and from P2 `liveKey = ['live']`, `inboxRootKey = ['inbox']`, `inboxKey(f) = ['inbox', f]`, `templatesKey(projectId) = ['templates', projectId ?? null]`, `archiveStatusKey = ['archive', 'status']`, `notificationPrefsKey = ['config', 'notifications']`, and from P3 `detailKeys` in `api/queries/session-detail.ts` → `['session', source, id, 'agents'|'stats'|'deliverables'|'files'|'usage'|'safety'|'links']` and `['session', source, id, 'raw', agentId ?? 'main']`, plus `['audit', filter]`, `['plans', q]`, `['plan', path]`, `['safety', 'secrets']`. P3 hooks: `useSessionAgents`, `useSessionStats`, `useSessionDeliverables`, `useSessionFiles`, `useSessionUsageSeries`, `useSessionSafety`, `useSessionLinks`, `useSessionRaw`, `useAudit`, `useSecretsReport`, `usePlans`, `usePlanContent`.
- **Live events (P2, `api/live-events.ts`):**
  ```ts
  export type WireEvent = LiveEvent                                     // the same variants as the daemon's wire type
  export const pkOf: (s: { source: Source; id: string }) => string      // `${source}:${id}`
  export function applyLiveEvent(qc: QueryClient, e: WireEvent): void
  export function liveWsUrl(loc: Pick<Location, 'protocol' | 'host'>, token: string): string
  export function useLiveEvents(opts?: { url?: string; WebSocketImpl?: typeof WebSocket }): { connected: boolean }
  ```
- **PTY transport (P1, as-built — `api/pty-socket.ts`, not in the original §12 draft):**
  ```ts
  export function ptySocketUrl(ptyId: string, token: string, loc: { protocol: string; host: string }): string
  export function connectPty(ptyId: string, h: PtySocketHandlers, o?: { token?: string; WebSocketImpl?: WebSocketCtor; location?: { protocol: string; host: string }; maxDelayMs?: number }): PtySocket
  // PtySocketHandlers: onData(Uint8Array), onExit(code), onStatus?(status), onReset?()
  // PtySocket: send(msg: PtyClientMessage), close()
  ```
  `connectPty` owns reconnect/backoff and realm-safe binary-frame decoding (a plain `instanceof ArrayBuffer`/`DataView` check fails across a jsdom-vs-Node realm boundary — Task 18's fix round; see the tag-based `toBytes()` helper).
- **P1 web feature directories (as-built):** `features/history/` (F3), `features/session-detail/` (F2), `features/terminal/` (F4 — `TerminalDock.tsx`, `TerminalView.tsx`, `ResumeActions.tsx`), `features/settings/` (F13 project settings), `features/shell/` (`AppShell.tsx`, `ProjectSelector.tsx`).
- **P2 web feature directories:** `features/live-board/` (`LiveBoard.tsx`, `SessionCard.tsx`, `StageBar.tsx`, `TestChip.tsx`, `OpenInButton.tsx`, `sort.ts`), `features/inbox/` (`InboxPage.tsx`, `useInboxKeys.ts`, `InboxCount.tsx`), `features/launch/LaunchDialog.tsx`, and `features/settings/{ArchiveSettings,NotificationSettings}.tsx`.
- **P4 web (as built):**
  - Routes `routes/worktrees.tsx` → `/worktrees`, `routes/review.$source.$id.tsx` → `/review/$source/$id`.
  - `features/worktrees/` (`WorktreesPage.tsx`, `WorktreeRow.tsx`, `CreateWorktreeDialog.tsx`), `features/review/` (`ReviewPage.tsx`, `FileTree.tsx`, `FileDiff.tsx`, `CommentComposer.tsx`, `CommentsPanel.tsx`, `ReviewAside.tsx`, `SummaryCard.tsx`, `CheckpointTimeline.tsx` — hides `safety` checkpoints, `ShipPanel.tsx`, `PresetButtons.tsx`, `useReviewDraft.ts`), `features/git/` (`GitDialog.tsx`, `GitConfirmDialog.tsx`, `useConfirmedMutation.ts`).
  - The kit has no Dialog primitive, so every P4 confirmation renders through `GitDialog` (backdrop, labelled `role="dialog"`, Escape closes); `useConfirmedMutation` turns a `409 confirmation_required` into a `GitConfirmDialog` and resends with `confirm: true`.
  - `features/live-board/PrChip.tsx` (`PrChip({ pr })`, live PR state via `usePrStatus`) and `features/inbox/InboxItemActions.tsx` (plan approve/reject and PR-event actions on inbox items) are new P4 components. PR status shows on session cards through `PrChip` only.
  - Hooks and keys: `api/queries/worktrees.ts` → `useWorktrees(f)`, `useDiscoverWorktrees()`, `worktreeKeys = { all: ['worktrees'], list: (f) => ['worktrees', f] }`; `api/queries/review.ts` → `useDiff` `['diff', cwd, from ?? null, to ?? null]`, `useCheckpoints` `['checkpoints', sessionPk]`, `useCheckpointDiff` `['checkpoint-diff', id]`, `useReview` `['review', source, id]`; `api/queries/github.ts` → `usePrStatus` `['pr', repo, number]`, `useGithubStatus` `['github', 'status']`; `api/queries/ship.ts` → `useShipSuggest` `['ship-suggest', cwd, sessionPk]`. There is no `['github', 'mine']` query yet.
- **P5 web (as built):**
  - Routes `routes/streams/index.tsx` → `/streams`, `routes/streams/$ticket.tsx` → `/streams/$ticket`, `routes/analytics.tsx` → `/analytics`.
  - Features: `features/streams/` (`StreamsPage.tsx` list + kanban, `StreamDetailPage.tsx`, `stages.ts`), `features/analytics/` (`AnalyticsPage.tsx`, `analytics-options.ts`, echarts), `features/limits/` (`QuotaBars.tsx` in the AppShell top bar with the `estimated` badge, `ContextFillBadge.tsx`, `format.ts`), `features/recaps/RecapPanel.tsx`, `features/goals/` (`GoalEditor.tsx`, `goal-format.ts`), `features/handoffs/HandoffPanel.tsx`, `features/reminders/ReminderPanel.tsx`, `features/session-detail/SessionWorkPanel.tsx`, and `features/settings/{RecapSettings,LimitsSettings,BridgeSettings,NumberInput}.tsx`.
  - Store: `stores/streams.ts` → `useStreamViewStore` `{ view: 'list' | 'kanban'; setView(v) }`, persisted in localStorage under `orc.stream-view`.
  - Hooks and keys: `api/queries/usage.ts` (`['usage']`, `['usage','budgets']`, `['usage','concurrency']`, `['usage','context',source,id]`, `['analytics',name,params]`, `['digest']`), `api/queries/streams.ts` (`['streams',filters]`, `['stream',ticket]`), `api/queries/work.ts` (`['recap',source,id]`, `['recaps','spend']`, `['goal',targetType,targetId]`, `['goals',states]`, `['handoff',source,id]`, `['reminders',filters]`), `api/queries/settings.ts` (`['settings']`, `['hooks','install']`, `['hooks','statusline']`). `usage.updated` is applied to `['usage']` in `api/live-events.ts`.
  - Tests load `@testing-library/jest-dom` in `src/test/setup.ts`.
- **P6 web (as built):**
  - Route `routes/pair.tsx` → `/pair` (`features/remote/PairPage.tsx`: code + device name → device token → passkey → notifications). Settings gains the sections "Connectors" (`features/settings/ConnectorsPanel.tsx`) and "Remote" (`features/remote/RemotePanel.tsx`: origin, login, pairing code, devices, away mode, push).
  - Features: `features/linear/LinearIssueChip.tsx` (on the stream detail page), `features/share/` (`ShareDialog.tsx`, `SessionShareActions.tsx`, `FollowUpDialog.tsx`, `DailyUpdateButton.tsx` on the Inbox page), `features/mobile/` (`useIsMobile.ts`, `MobileNav.tsx`, `InboxItemMobileCard.tsx`, `ReplyComposer.tsx`, `ReadOnlyDiff.tsx`).
  - **Mobile breakpoint:** `MOBILE_QUERY = '(max-width: 767px)'` (`features/mobile/useIsMobile.ts`). On mobile, `AppShell` renders a bottom tab bar (`MobileNav`, `aria-label="Mobile navigation"`) instead of the left nav and hides the terminal dock; the review page shows `ReadOnlyDiff`.
  - **Token:** `api/token.ts#resolveToken()` returns a non-empty `window.__ORC_TOKEN__`, else the device token in `localStorage['orc.deviceToken']` (`DEVICE_TOKEN_KEY`; `setDeviceToken`, `clearDeviceToken`, `isLoopbackOrigin`). P1's `getToken()` delegates to it; `api/client.ts` also exports `resetApiClient()` so the client is rebuilt after pairing.
  - **Step-up:** `api/step-up.ts#withStepUp(fn, stepUp = performStepUp)` runs `fn`, and on `step_up_required` asks for the passkey once (`@simplewebauthn/browser` `startAuthentication`) and retries exactly once.
  - **Client methods** come from `packages/api-contract/src/client-p6.ts#p6Methods(call: Caller)` (type `P6Methods`, plus `isApiErrorWithCode(e, code)`), spread into `createApiClient`: `connectorsList`, `connectorsSetToken`, `connectorsSetApp`, `connectorsAuthorize`, `connectorsDisconnect`, `linearIssue`, `linearComment`, `linearFollowUp`, `slackPost`, `sessionsReply`, `inboxApprove`, `remoteStatus`, `remoteSetConfig`, `remoteCreatePairing`, `remotePair`, `remoteDevices`, `remoteRevokeDevice`, `awayGet`, `awaySet`, `webauthnRegisterOptions`, `webauthnRegisterVerify`, `webauthnStepUpOptions`, `webauthnStepUpVerify`, `pushPublicKey`, `pushSubscribe`, `pushUnsubscribe`, `pushTest`.
  - **Query keys:** `api/queries/connectors.ts` `connectorsKeys.all = ['connectors']`; `api/queries/linear.ts` `linearKeys.issue(identifier) = ['linear-issue', identifier]`; `api/queries/remote.ts` `remoteKeys = { status: ['remote-status'], devices: ['remote-devices'], away: ['away'] }`.
  - **PWA:** `vite-plugin-pwa` with `strategies: 'injectManifest'` and the service worker `src/sw.ts` (its own `tsconfig.sw.json`, typechecked by `pnpm --filter @orc/web typecheck`). It precaches only static build assets (`**/*.{js,css,html,svg,png,woff2}`) and never caches API responses or transcript text. `pwa/register.ts` registers it, `pwa/push.ts` (`enablePush`, `disablePush`) manages the subscription, `pwa/push-payload.ts` parses pushes. Icons live in `public/icons/`.
- **Tests:** component tests with Testing Library and an MSW-free fake client (`api/client.ts` exports `setApiClientForTests`). E2E runs with Playwright against the daemon started on fixtures (`apps/web/e2e/*.spec.ts`, via `pnpm --filter @orc/web e2e`).

## 13. Symbol ownership & de-duplication

The phase plans were written in parallel, so several symbols appear in more than one plan. **The owning phase creates the file. A later phase that needs a different shape MODIFIES the owner's file (its task lists the file under `Modify:`) and never re-creates the symbol.** Before creating any exported symbol, check this table.

| Symbol | Canonical owner & location | Rule for later phases |
|---|---|---|
| `RegistryEntry`, `parseRegistryFile`, `registryStatusToLive`, `isRegistryFileName` | **P1** `packages/core/src/claude/registry.ts` | The canonical shape is the **P2 superset**: `{ pid, procStart: string \| null, sessionId, cwd, startedAt: number \| null, version, kind, name, status: RegistryStatus \| null, waitingFor, statusUpdatedAt: number \| null, updatedAt: number \| null }` with `export type RegistryStatus = 'busy'\|'idle'\|'waiting'\|'shell'`. P1 implements that shape and exports both `parseRegistryEntry` and the alias `parseRegistryFile`. P2 adds only `isRegistryFileName`. Neither ever copies `messagingSocketPath`. |
| `isTestCommand`, `parseTestOutput` | **P1** `packages/core/src/derive/tests.ts` | P2 imports them; its Task 3 covers stage inference only. |
| `splitPk`, `sessionPk` | **P1** `apps/daemon/src/db/keys.ts` (re-exported from `services/sessions.ts`) | P2/P4/P7 import. |
| `slugify` | **P1** `packages/core/src/derive/name.ts` — `slugify(name: string): string` for project ids | P4's branch slug is a **different** function. As built it is declared as `slugify` in `packages/core/src/git/branch.ts` and exported from the `git/index.ts` barrel as **`branchSlug`** (the plan's `slugifyBranch` name was not used). Import `branchSlug`, never `git/branch.ts`'s `slugify`, next to `derive/`. |
| `shellQuote` | **P1** `apps/daemon/src/services/sessions/external.ts` — `shellQuote(parts: string[]): string` | P5's single-argument quoting shipped as a second, module-local `shellQuote(s: string): string` in `apps/daemon/src/services/hooks/install.ts` (not `quoteArg`). Import the one whose signature you need, by path. |
| `permissionBadge`, `PermissionBadge` | **P3** `packages/core/src/derive/permission.ts` (as built; `prod.ts` keeps P1's `DEFAULT_PROD_PATTERNS`, and P3's prod detection is `derive/prod-detect.ts`) — `permissionBadge(modes: readonly (string \| null \| undefined)[]): PermissionBadge` | P2's card helper takes one mode: name it `badgeForMode(mode: string \| null)` in `apps/web/src/features/live-board/format.ts`, or call the P3 function with `[mode]` once P3 has shipped. |
| `createLiveReducer`, `LiveReducer`, `TranscriptLive` | **P2** `packages/core/src/derive/live-transcript.ts` | P5 extends the options (`windows`) by **modifying** that file; its context-window table lives in config. |
| `registerHookRoutes`, `mapHookToStatus` | **P2** `apps/daemon/src/http/routes/hooks.ts` (minimal ingest) | P5 replaces the body by **modifying** the same file; the route path stays `POST /api/hooks`. |
| `redactSnippet`, `redactValue`, `redactSession`, `redactListItem`, `redactedApiError` | **P1** `apps/daemon/src/http/redact-out.ts` | P2/P3 extend by modifying that file. P3 adds `redactDeep`/`redactPartialTokens` in `packages/core/src/redact/redact.ts`, `redactedJson` in `http/redacted-json.ts` and `toWireEvent` in `http/ws-redact.ts`. Every new route answers errors through `redactedApiError`. |
| `ApiRequestError` | **P1** `packages/api-contract/src/client.ts` | P2/P3 must use it. `ApiCallError` is not a separate class; delete that name where a plan uses it. |
| `ConfirmBody` | **P2** `packages/api-contract/src/routes/common.ts` | P4 (`Confirm`), P6 and P7 import `ConfirmBody`. |
| `PrRefSchema`, `PrStatusSchema` | **P1** `packages/api-contract/src/routes/sessions.ts` (PrRef), **P4** `routes/ship.ts` (PrStatus) | P4/P5/P7 import; never redeclare. As built, `routes/ship.ts` also declares `ShipPrRefSchema` for the ship route bodies. |
| `UsageSchema`, `SessionSchema`, `TimelineEventSchema`, `AgentNodeSchema` | **P1** `packages/api-contract/src/routes/sessions.ts` (as built, `UsageSchema` lives in `packages/api-contract/src/domain.ts`) | All later phases import. P3's `routes/session-detail.ts` imports `UsageSchema` from `domain.ts`. |
| `LaunchRequest`, `LaunchResponse`, `Template` | **P2** `packages/api-contract/src/routes/launch.ts` / `templates.ts` | P4 and P7 extend `LaunchRequest` by modifying that file (P4 enables `planApproval`/`worktree`, P7 enables `compare`). |
| `PrStatus` (domain type) | **P4** `packages/core/src/types/work.ts` | The `connectors/github/github.ts` file re-exports it; §11's inline copy is superseded by P4's (adds `headRef`, `failedChecks`). |
| `createLinearAssignedPoller`, `createSlackMentionPoller`, `PollerHandle`, BusEvents `linear.issueChanged` / `slack.mention` | **P6** `apps/daemon/src/connectors/linear/assigned-poller.ts`, `apps/daemon/src/connectors/slack/mention-poller.ts`, `apps/daemon/src/live/event-bus.ts` | Already running after P6 (started by `createPhase6().start()`). P7 subscribes to the bus events for automation triggers and does not create or start a second poller. |
| `LinearIssue` | **P6** `packages/api-contract/src/routes/connectors.ts` (zod), re-exported as a type from `apps/daemon/src/connectors/linear/linear.ts` | P7 imports it; no second definition. |
| `createPhase6`, `Phase6Options`, `RemoteAccess`, `Who`, `whoOf`, `remoteOf`, `requireLoopback` | **P6** `apps/daemon/src/phase6.ts`, `context.ts`, `http/p6-util.ts` | Later remote-aware routes use `whoOf(c)` for the audit actor and `requireLoopback(c)` for Mac-only writes. |
| `LIVE_EVENT_TYPES` | **P2** `apps/daemon/src/http/live-ws.ts` | Every later phase that adds a `LiveEvent` variant appends to this array in the same file (P3 `audit.recorded`; P4 `worktree.updated`, `worktree.removed`, `pr.updated`, `checkpoint.created`; P5 `usage.updated` payload typing). |
| `Route`, `OrcApp`, `registerXRoutes` | **P1** `apps/daemon/src/http/app.ts` | The `Route`/`OrcApp` types are declared once in P1; each phase adds its own `registerXRoutes(app: OrcApp, ctx: DaemonContext)` file. |
| `DaemonContext`, `buildContext`, `createDaemon`, `ServiceError` | **P1** `apps/daemon/src/context.ts`, `services/errors.ts` | Later phases add fields to `DaemonContext` by modifying that file (see §11). P3's `audit` and `denyList` are required fields because `buildContext` always creates them. |
| `CORE_VERSION`, `FIXTURES_DIR` | **P0** `packages/core/src/index.ts`, `src/test-utils/fixtures.ts` | P1 reuses them. |
| `encodePaste`, `sendText` | **P0** `packages/core/src/pty/paste.ts` (real, pure module — amended from the brief's original throwaway-spike-file plan; see Task 6 ruling) | The S2 spike server (`spikes/s2-pty/server.ts`, outside the pnpm workspace) imports this module by relative path. P1's `apps/daemon/src/pty/input.ts` wraps it rather than re-implementing it. |
| `SessionDetailPage` and any other web page component | The phase that **creates** the route file owns it (P1 for `/sessions/$source/$id`) | P3 and later **modify** it; they never create a second component with the same name. |
| `useInboxKeys` | **P2** `apps/web/src/features/inbox/keys.ts` | P3 modifies it to register through the `hotkeys` registry. |
| Web formatting helpers: `formatDuration`, `formatTokens`, `formatCost`, `shortPath`, `toolLabel`, `hasDrift` | **P1** `apps/web/src/lib/format.ts` | Every later phase imports from there and adds new helpers to the same file. |
| Stats helpers `median`, `percentile` | **P3** as built: only `median(xs: readonly number[]): number \| null`, in `packages/core/src/derive/step-stats.ts`. There is no `stats-math.ts` and no `percentile` yet. | P5/P7 import `median` from there; the first phase that needs `percentile` adds it to the same file. |
| Test factories: `makeSession`, `makeInboxItem`, `createFakePty`, `fakeApi`, `fakeSessions`, `fakeProjects`, `fakeInbox`, `makeQueryClient`, `ev`, `need` | **Daemon:** P1 `apps/daemon/test/factories.ts`; **web:** P1 `apps/web/src/test/factories.ts` | Each later phase adds new factories to those files and imports the existing ones instead of redefining. `createTestContext`/`useTempHomes` stay in `apps/daemon/test/helpers.ts`. |

| `ApiCallError` | — (not a class) | P2/P3 use **P1**'s `ApiRequestError`. `packages/api-contract/src/client-p3.ts` re-exports it as `export { ApiRequestError as ApiCallError }` so the P3 tests can import that name; it is the same class. Later phases import `ApiRequestError`. |
| `AppOptions`, `createApp`, `getToken` | **P1** `apps/daemon/src/http/app.ts`, `apps/web/src/api/client.ts` | P6 extended them: `AppOptions` gained `remote?: RemoteGuardDeps \| null` and `phase6?: { guardDeps } \| null` (no route registration through it), and `getToken()` delegates to `resolveToken()` in `api/token.ts`. A new remote-reachable route must get a `REMOTE_RULES` entry in `http/remote-guard.ts` or it falls under the defaults (remote reads need a device, remote writes are denied). |
| `BusEvent`, `LiveEvent` | **P1** `apps/daemon/src/live/event-bus.ts`, `packages/api-contract/src/live.ts` | Every later phase appends variants to the same unions in those files (P4 worktree/PR/checkpoint, P5 `config.changed` and the typed `usage.updated`, P6 Linear/Slack/away, P7 automation/supervisor/compare). P6 owns `linear.issueChanged` and `slack.mention`; P7 imports them instead of re-adding them. |
| `DEFAULT_TICKET_REGEX` | **P1** `packages/core/src/derive/tickets.ts` | P4's branch parser has its own regex in `git/branch.ts`, exported from the `git/index.ts` barrel as **`DEFAULT_BRANCH_TICKET_REGEX`**. |
| `resumeCommand`, `resumeCommandLine` | **P1** `apps/daemon/src/services/sessions/external.ts` | P2 and P7 import; P7's compare/automation launches go through `spawnClaudeSession`. |

| `ServiceError` for P4 routes | **P1** `apps/daemon/src/services/errors.ts` | P4 has no `HttpError`: `GitError` from `services/git/exec.ts` maps to `ServiceError` through `toHttpError` + `GIT_ERROR_STATUS` in `http/routes/git-guard.ts`. Later phases throw `ServiceError`. |
| `PrChip` | **P4** `apps/web/src/features/live-board/PrChip.tsx` | Later phases reuse it for PR state; do not add a second PR badge. |
| `InboxItemActions` | **P4** `apps/web/src/features/inbox/InboxItemActions.tsx` | Kind-specific inbox actions; later phases add a `case` for their kind here. |
| `GitDialog`, `GitConfirmDialog`, `useConfirmedMutation` | **P4** `apps/web/src/features/git/` | The shared modal frame and the 409-confirm flow, used because the kit has no Dialog. Later confirmed actions reuse them. |
| `createPhase4Methods`, `Phase4Client` | **P4** `packages/api-contract/src/client-phase4.ts` | Spread into `createApiClient`; later phases follow the same per-phase client file pattern. |
| `wirePhase4` | **P4** `apps/daemon/src/main.ts` | Creates the P4 services and their bus hooks; called by `createDaemon()` and by tests with `{ startPollers: false }`. |

| `p5ClientMethods`, `P5ClientMethods` | **P5** `packages/api-contract/src/client-p5.ts` | Spread into `createApiClient`, like `createPhase4Methods`. |
| `need` (daemon) | **P5** `apps/daemon/src/services/need.ts` | Routes that read an optional `DaemonContext` service use it; do not add another "service not wired" helper. |
| `readBody`, `readQuery`, `confirmationRequired`, `notFound`, `sendError`, `parseStates` | **P5** `apps/daemon/src/http/p5-util.ts` | Later main-app route files reuse them. |
| `Scheduler`, `ensureCronJob`, `removeJobsOfType` | **P5** `apps/daemon/src/services/scheduler/scheduler.ts` | P7 extends the `ScheduledJob['kind']` union (`'reminder' \| 'automation' \| 'digest'`) and registers `onFire('automation', …)` there; no second scheduler. |
| `createPhase7`, `Phase7Options`, `offlinePhase7` | **P7** `apps/daemon/src/phase7.ts`, `apps/daemon/test/fakes/phase7.ts` | The only P7 wiring point; every test `createDaemon` passes `phase7: offlinePhase7()`. |
| `ConfirmBody`, `requireConfirmed`, `need` (P7 flavour), `API_BASE`, `TEST_TOKEN` | **P7** `apps/daemon/src/http/p7-guard.ts` | P7 routes and tests import from there; `need` here answers `409 not_enabled` (P5's `services/need.ts` and P6's `http/p6-util.ts` keep their own). |
| `DiffStat` / `DiffStatSchema` | **P7** `packages/api-contract/src/routes/p7-common.ts`, `apps/daemon/src/services/git/git-info.ts` | Automations and compare share it. |
| `median` (compare) | **P7** `apps/daemon/src/services/compare/compare.ts` | A local `median(values: number[])` beside P3's `derive/step-stats.ts` one; fold them together when one moves. |
| `resolveWstackHome`, `readWstackWorkflows`, `readWstackTimelines` | **P5** `apps/daemon/src/services/wstack.ts` | The only reader of `WSTACK_HOME`. |
| `makeP5Context`, `makeSession` (P5 variant), `fakeSessions`, `withWakecap`, `ev` | **P5** `apps/daemon/test/p5-helpers.ts` | Service tests that need a fake session list use these. |
| `Indexer`, `createIndexer` | **P1** `apps/daemon/src/indexer/indexer.ts` | Not in the original §11 draft. Later phases that need indexing hooks modify this file rather than creating a parallel indexer. |
| `UserMetaService`, `createUserMetaService` | **P1** `apps/daemon/src/services/user-meta.ts` | Owns pins/labels/saved views (F3). Not anticipated by the original plan; later phases extend by modifying this file. |
| `ExternalLauncher`, `createExternalLauncher`, `resumeCommandLine`, `appleScriptString` | **P1** `apps/daemon/src/services/external.ts` | `resumeCommandLine`/`shellQuote` were originally drafted under `services/sessions/external.ts`; the as-built path is `services/external.ts` (no `sessions/` subdirectory). P2/P7 import from this path. |

**Unknown request-body keys → HTTP 422 everywhere (P1, Task 12 ruling, reconciled at the phase exit).** Every write-body schema (`ResumeRequestSchema`, `PinRequestSchema`, `LabelRequestSchema`, `SaveViewRequestSchema`, `ProjectPatchSchema`) is a `z.strictObject`. `apps/daemon/src/http/json.ts`'s `readJson()` inspects the Zod error: an `unrecognized_keys` issue (a typo'd or extra key) returns **422** `validation_failed`; every other validation failure (wrong type, failed refinement, malformed JSON) returns **400** `validation_failed`. Query-string schemas stay permissive (unknown query params are silently ignored, never 422) — only request bodies are strict. This single rule replaced an earlier inconsistent 400-for-everything convention found during Task 12's review.

**Execution rule:** when a task says "Create" for a file that an earlier phase already created, the executor changes it to "Modify", keeps the existing exports, and adapts the surrounding code. If the two shapes genuinely conflict, the **later** phase adapts to the earlier one unless this table says otherwise, and the change is noted in the task's review note.

## 14. Spike outcomes that bind later phases

Phase 0's spikes settled several questions the phase plans left open. These override the plan text where they differ.

| Spike | Outcome | What it binds |
|---|---|---|
| **S1** parser | GO. 968 files / 852 MB / 210,285 lines parsed in 3.3 s, 0 bad JSON, 0 partial files, **0 unknown record types** (Claude Code 2.1.275). | The `classifyClaudeRecord` type lists are complete for this version. `docs/04-data-sources.md`'s claim that a tool result needs `toolUseResult` **and** `sourceToolAssistantUUID` is wrong: all 42,408 records with `toolUseResult` also have the UUID, and the 808 with only the UUID carry a `tool_result` content block and classify correctly. `records.ts` stands as written. |
| **S3** live status | GO, **watch-only**. Live transitions detected in 3–107 ms (median 27, n=6). | Phase 2 builds the Live Board on the chokidar registry watcher alone; the hook bridge (F10) stays a Phase 5 optimisation. Registry reads must swallow `ENOENT`/parse errors (partial writes are normal). `statusUpdatedAt` is status *age* at first scan, not a detection delay. A `waiting` transition was never observed in the window — Phase 2 must measure that case and record it. |
| **S5** codex | Rollouts parse cleanly; originators observed: `codex_exec`, `codex_sdk_ts`, `codex-tui`, `Codex Desktop`. | Phase 1's Codex aggregate filters `codex_sdk_ts` by default (decision 3). The `automated` flag keys on originator. The report's actual decision also carries: read the Codex SQLite read-only as well; the rollout-mtime<10s process-matching rule is untested under load; and the originator list came from a 5.2% recency-biased sample. |
| **S7** quota | **official** source found. | `LimitsConfig.quotaSource` defaults to `'official'`, with `officialFieldPaths` defaulting to `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at`. These arrive on the **statusline command's stdin JSON**, so Phase 5's `POST /api/usage/official` is fed by the orchestrator statusline wrapper. The ccusage-style estimator stays as the labelled-"estimated" fallback for when no statusline is installed. Phase 5 must not overwrite a user's existing statusline — it merges or wraps. Caveats: n=1 on one Max account; `/usage` parity was never checked; and `rate_limits` may be absent on some plan tiers or before the first API response, so Phase 5 must fall back to the estimator when the field is missing. |
| ~~**S6** Wakecore~~ | **Dropped by the user (2026-09-21):** this is a personal project, so it uses open-source shadcn/ui outright instead of a private work package. The spike's blocked-on-`read:packages` finding is moot. | `@/components/ui/*` is the permanent home of the primitives, not a fallback. |
| **P1 Task 19, redaction boundary** | Not a Phase-0 spike, but binds later phases the same way. Five fix rounds (3, 4, 5, 5b — round 1-2 were the perf fix, unrelated) found and closed **12 distinct raw (unredacted) transcript-text paths** that the original §8/route-layer redaction design believed were already covered: (1) the wide-fan-out `eventSnippet` fallback, (2) the `history_prompts` search-fallback highlight, then five more found by an explicit sweep (`TimelineEvent.tool`, `TimelineEvent.mcpServer`, `AgentNode.agentType`, `Session.cwds`, `Session.mcpServers`), then five more found by an *adversarial* re-verification of that sweep (`Session.startCwd`, `Session.skills[]`, `Session.filesTouched[]`, `Session.live.waitingFor`, `Session.tickets[]`/`SessionListItem.tickets[]`). The final boundary is `apps/daemon/src/http/redact-out.ts`'s `redactSession`/`redactListItem`/`redactEvent`/`redactAgent`/`redactSnippet` — every field either routes through `redact()` (a no-op on ordinary values, so tickets/paths/skill names stay matchable) or is deliberately excluded with a stated reason (`transcriptPath` — daemon-derived; `labels`/saved-view/project names — user-authored in-app; `models`/`permissionMode` — fixed vocabularies; `prs` — extraction unimplemented this phase). **Two of the 12 were a redact/truncate ORDER bug** (`highlight()` truncates by raw character offset, so a naive `redact(highlight(text))` can bisect a secret pattern across the truncation boundary and let it survive) — fixed once via a shared `redactedHighlight(text, needle, radius) = highlight(redact(text), needle, radius)` helper in `services/snippet.ts`. **The lesson recorded for later phases:** each round's manual sweep table missed fields the next round's exhaustive guard test found — the guard test (one seeded secret-bearing session + subagent + history-prompt row, checked against all four session-returning routes at once) is what actually holds this boundary, not the sweep table. Any new fallback path added to `sessions.ts`'s `list()` must default to `redactedHighlight()` rather than assuming the route-layer pass will catch it. **AMENDED BY P2 TASK 8 (fix rounds 1-2)** — see the row below. |
| **P2 Task 8, redaction boundary (amends the row above)** | The exhaustive guard test the row above calls "what actually holds this boundary" **did not exist** — it was cited in rulings from Task 1 onward and was first written in P2 Task 8 (`apps/daemon/src/http/redact-out.test.ts`). Writing it, and two adversarial review rounds on it, changed four things that bind later phases. **(1) Three of the P1 exclusions are reversed.** `labels`, saved-view names/queries and project *list* names/`pathPrefixes` are now redacted, and so are `models`, `permissionMode`, `transcriptPath`, `prs[].repo`/`url`, `LiveState.currentTool`, `TimelineEvent.model` and `AgentNode.transcriptPath`. "User-authored in-app" is not a safety property: a user pastes a token into a label, and `pathPrefixes` are literally the cwd prefixes `Session.startCwd` is redacted for. `redact()` is a no-op on ordinary values, so nothing user-facing changed. **(2) TWO deliberate exceptions remain, both for the same round-trip reason. `SavedView.query`** is a user-authored search string that `SavedViews.tsx` applies straight from the SERVED view, so redacting it would silently search for something else and persist the tag on the next save — and it would break the pointed use case, since searching your own transcripts for a leaked secret is a first-class use of this tool. `SavedView.name` is still redacted. **`GET /api/projects/:id` and its `PATCH`**, because they are the settings editor's round trip: a tag written into the GET is PATCHed back into the user's own `config.json`, where `firstRelativePrefix` rejects `«redacted:…»` as non-absolute and the user can no longer save. The exposure is the whole `ProjectConfig`, including `repos[].setup`/`run`/`archive` — user-authored shell command lines. Nothing displays or forwards them today; the fix when that changes is to redact the GET and make PATCH treat any incoming field still containing `«redacted:` as "unchanged". **(3) Redaction is no longer value-only.** `redactValue` is key-aware (a key naming a credential redacts its value whatever the value looks like), carries that flag down through nested objects, handles the `{name,value}`/`{key,value}` pair form, and redacts object keys as well as values — because `redact()`'s patterns need `KEYWORD=VALUE` inside ONE string and JSON splits the two apart, so `{"env":{"PGPASSWORD":"hunter2"}}` was served raw. It over-redacts `*token*` keys; `usage.updated` is the one wire shape whose subject is token counts and may need its own redactor. **(4) Error bodies are part of the boundary.** `ServiceError.message` and `.details` are redacted in `app.ts`'s `onError`; `cwd_missing` was serving `startCwd` raw. The guard is now a chain, and every link fails closed: routes (registered only in files the census lists, and enumerated across the whole `createApp` option space rather than one point in it) → census (`apps/daemon/test/route-census.ts`, shared by both test files) → redactor → schema walk → a live sentinel probe in `app.test.ts` DERIVED from the census, so a row naming a redactor its handler never calls fails. Error bodies are built only through `redactedApiError`, enforced by a file allowlist. `SECRET_KEY`'s alternatives are pinned by an independently-written corpus of real credential key names, not by samples derived from the list itself. **Note for later phases: a zod v4 `ZodError` is NOT an `instanceof Error` here, so Hono rethrows it instead of routing it to `onError` — every request validation must go through `readJson`/`parseWith`, which wrap it in a `ServiceError`.** **Any new response shape or route in phases 3+ must be added to the census in the same task that introduces it.** |
| **P1 Task 14, browser type-import boundary** | Not a spike — a deliberate P1 tradeoff recorded here per the ledger's explicit instruction. `apps/web/tsconfig.json` keeps `types: ["vite/client", "node"]` rather than rewriting every `apps/web` and `api-contract` type-only import to a `@orc/core/browser` subpath entry point. This means `apps/web`'s **typecheck** can see `@types/node` (TS type-checks the whole transitive graph reached by any `import type` from the full `@orc/core` barrel, and contracts §11 sanctions importing types from that barrel), so a careless future `import { readFile } from 'node:fs'` in a web component would typecheck — it is only the Vite **build** that would catch it (verified: the built `apps/web/dist` bundle greps clean for `node:` imports). If a later phase wants strict per-file browser/Node isolation enforced at typecheck time, that is a phase-level decision to point `api-contract` and `apps/web` at `@orc/core/browser` everywhere — a five-site change across two packages (three in `api-contract`, two in brief-authored `apps/web` files), not attempted in P1. |
| **P1 Task 19, search-perf cardinality cap** | A synthetic-then-real two-stage tuning exercise, not a spike, but the empirical constant it produced binds the search-quality/perf tradeoff for later phases. `toFtsQuery` prefix-matches only the *last* (still-being-typed) token of a query, 3+ characters; every earlier token becomes an exact term. FTS5's native `snippet()` cost scales with the prefixed token's *matched-term cardinality*, not row count — a synthetic worst case (a numbered vocabulary where one 4-char prefix matched ~1,111 of 3,000 terms) took ~4s per search before this was found. Above `FTS_PREFIX_CARDINALITY_CAP = 250` (`apps/daemon/src/services/sessions.ts`), a search skips native `snippet()` and highlights the raw row text in application code instead (via `redactedHighlight`, so the secret-leak fix applies uniformly). **250 is empirical, not derived**: measured directly against the real `~/.claude`/`~/.codex` corpus's actual term cardinality and `snippet()` cost per common English 3-character prefix (`con`→489 terms/188ms was the one real-world case that exceeded the 150ms budget; every measured case ≤244 terms stayed under ~75ms). Real-text cost is **not monotonic in cardinality alone** (`con` cost 4-6x more than `get` at nearly the same cardinality) — a future corpus with different vocabulary characteristics could still occasionally exceed the cap's safety margin; the perf suite's gated per-shape assertions (not this cap alone) are the regression backstop. Phase 2+ should re-measure this cap if the indexed corpus's vocabulary shape changes materially (e.g. adding a new source with very different token distributions). |
| **S2/S8** PTY | Scripted input **50/50** complete and in order; send-while-busy is queued by Claude's own TUI (not garbled); multi-line arrives as one prompt. `submitDelayMs` 120 ms works, and no idle detection is needed before sending. Browser render, typing, resize and scrollback replay all verified in headless Chrome. **GO.** | `encodePaste`/`sendText` live in `packages/core/src/pty/paste.ts`; Phase 1's `apps/daemon/src/pty/input.ts` wraps that module. **Two Phase 1 setup gotchas:** (1) node-pty 1.1.0's darwin-arm64 prebuild ships `spawn-helper` without the executable bit, and every `pty.spawn()` fails until it is `chmod +x`'d — the daemon package needs a postinstall step. (2) **A child session inherits `CLAUDE_CODE_CHILD_SESSION` and then writes NO transcript.** `PtyManager.spawn()` must delete that marker from the child env and set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, with a test asserting it; otherwise every session the app launches is invisible to its own indexer. |
| **S9** remote | **Read-only checks only (2026-09-27); live checks a–h not yet run.** Tailscale 1.102.3 running; MagicDNS and HTTPS certificates on; origin `https://hazems-macbook-pro.tailc6e70.ts.net`; login `hazem@wakecap.com`; the tailnet is shared (161 devices), so `remote.allowedLogin` is the real gate. Decision: go with the plan's defaults, unconfirmed (`plan/spikes/S9.md`). | Phase 6 shipped on those defaults: `isRemoteRequest` header rules (b), the `Tailscale-User-Login` identity check (c — **NO-GO for remote access if `tailscale serve` does not strip a client-sent header**), Web Push (d1/d2), passkey rpID = MagicDNS host (e1/e2), `connectors.slack.redirectUri` (g1), `nudgeViaReminder: false` (g2/g4), the bridge's `appId` reply filter (g3) and the `AllowFunnel` key in `detectFunnel()` (h). Each changes as the S9 decision table says if its check fails. |
| **S4** AGNC | **GO (unconfirmed); read-only checks only (2026-09-27); live checks a–f not yet run.** The OAuth metadata is standard OAuth 2.1 for MCP: protected-resource metadata, PKCE `S256`, `authorization_code` + `refresh_token`, dynamic client registration, public clients. **Observed:** AGNC answers `initialize` with no token (protocol `2025-03-26`) (`plan/spikes/S4.md`). | Phase 7 shipped the AGNC connector and routes on that decision, off by default (`agnc.enabled: false`). Because `initialize` needs no token, `createAgncConnector` sends `listTools()` after `connect()` before it treats the client as authorised, and an `UnauthorizedError` from a later `callTool` also starts the OAuth flow. The redirect URI `http://127.0.0.1:<port>/oauth/agnc/callback` (b), `agnc_list_sessions { scope: 'mine' }` (c), the response key spellings in `normalize.ts` (c, d) and token refresh (e) are unconfirmed. If a, c or e fails, AGNC goes NO-GO: keep `agnc.enabled` off and ship only the link-out. |
