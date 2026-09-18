# Phase 0 — Foundations & Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the monorepo with its tooling and the `@orc/core` basics (types, JSONL tailer, record classifier, redaction, fixtures), and run the spikes that reduce risk (M0). Every spike records a go/no-go decision.

**Architecture:** A pnpm workspace with `packages/core` (pure TypeScript), `packages/api-contract` (zod), `apps/daemon` and `apps/web`. This phase only scaffolds the two apps. Spikes live in `spikes/`, are not built, and write their results to `plan/spikes/<id>.md`.

**Tech Stack:** Node 22, pnpm 10.18.3, TypeScript ~6.0.3, Vitest 5, Biome 2, zod 4, node-pty 1.1, @xterm/xterm 6, chokidar 5.

**Spec:** `docs/03-architecture-and-stack.md`, `docs/04-data-sources.md`, `docs/05-roadmap.md` (M0), `plan/00-contracts.md`

## Global Constraints
- Node `>=22.12 <23`; pnpm `10.18.3` pinned through `packageManager`.
- TypeScript `strict: true`, plus `noUncheckedIndexedAccess: true` and `verbatimModuleSyntax: true`.
- `@orc/core` must not import `node:fs`, `node:net` or `node:child_process` anywhere except `src/io/*`.
- **Read-only access to `~/.claude` and `~/.codex`.** Spikes never write there, and never read `*.key`, `~/.codex/auth.json`, or any auth fields in `~/.claude.json`.
- Fixtures must be redacted: no real tokens, hostnames, customer names or prompt text copied from real sessions.
- Commits use Conventional Commits (`plan/00-contracts.md` §10). Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.
- Work on branch `phase/0-foundations`.

---

## File Structure (created in this phase)
```
package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  vitest.config.ts  .nvmrc  .gitignore  .npmrc
packages/core/{package.json,tsconfig.json,vitest.config.ts}
packages/core/src/index.ts
packages/core/src/types/{session.ts,events.ts,inbox.ts,work.ts,audit.ts,index.ts}
packages/core/src/io/jsonl-tail.ts           + test
packages/core/src/claude/records.ts          + test
packages/core/src/redact/redact.ts           + test
packages/api-contract/{package.json,tsconfig.json}
packages/api-contract/src/{index.ts,config.ts,errors.ts}   + test
apps/daemon/{package.json,tsconfig.json}  apps/daemon/src/main.ts
apps/web/{package.json,tsconfig.json,index.html,vite.config.ts}  apps/web/src/main.tsx
fixtures/claude-home/**  fixtures/codex-home/**  fixtures/README.md
scripts/check-fixtures-redacted.mjs
spikes/s1-parser-dryrun/  spikes/s2-pty/  spikes/s3-registry/  spikes/s5-codex/  spikes/s6-wakecore/  spikes/s7-quota/
plan/spikes/{S1,S2-S8,S3,S5,S6,S7}.md
```

---

### Task 1: Repository scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.npmrc`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; workspace package `@orc/core`

- [ ] **Step 1: Initialise git and branch**

```bash
cd /Users/hazem/orchestrator
git init -b main
git add docs plan
git commit -m "docs: add design docs and implementation plans"
git checkout -b phase/0-foundations
```

- [ ] **Step 2: Write root config files**

`package.json`
```json
{
  "name": "orchestrator",
  "private": true,
  "packageManager": "pnpm@10.18.3",
  "engines": { "node": ">=22.12 <23" },
  "type": "module",
  "scripts": {
    "build": "pnpm -r --if-present build",
    "dev": "pnpm -r --parallel --if-present dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "biome check .",
    "format": "biome check --write .",
    "check:fixtures": "node scripts/check-fixtures-redacted.mjs"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.14",
    "@types/node": "^22.10.0",
    "typescript": "~6.0.3",
    "vitest": "^5.0.1"
  }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - "apps/*"
  - "packages/*"
onlyBuiltDependencies:
  - better-sqlite3
  - node-pty
  - esbuild
```

`tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "noEmit": true
  }
}
```

`biome.json`
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "files": { "includes": ["**", "!**/dist", "!**/node_modules", "!fixtures/**", "!**/migrations/**", "!spikes/**/out"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  }
}
```

`vitest.config.ts` (root; uses `test.projects` — the `defineWorkspace`/`vitest.workspace.ts` API was
dropped)
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { projects: ['packages/*', 'apps/*'] } });
```

`.nvmrc`
```
22
```

`.gitignore`
```
node_modules/
dist/
coverage/
*.log
.DS_Store
spikes/**/out/
.env
.env.*
```

`.npmrc`
```
@wakecap:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
auto-install-peers=false
```

- [ ] **Step 3: Create `@orc/core` package skeleton**

`packages/core/package.json`
```json
{
  "name": "@orc/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```

`packages/core/tsconfig.json`
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }
```

`packages/core/vitest.config.ts`
```ts
import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'core', environment: 'node', include: ['src/**/*.test.ts'] } });
```

`packages/core/src/index.ts`
```ts
export const CORE_VERSION = '0.0.0';
```

- [ ] **Step 4: Write a smoke test**

`packages/core/src/smoke.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from './index.ts';

describe('core smoke', () => {
  it('exports a version', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });
});
```

- [ ] **Step 5: Install and run everything**

Run: `pnpm install && pnpm lint && pnpm typecheck && pnpm test`
Expected: install succeeds; biome prints `Checked N files … No fixes applied`; typecheck exits 0; vitest reports `1 passed`.

If biome complains about formatting, run `pnpm format` and re-run.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(repo): scaffold pnpm workspace with TS, Biome and Vitest"
```

---

### Task 2: Domain types, redaction and redacted fixtures

**Files:**
- Create: `packages/core/src/types/session.ts`, `events.ts`, `inbox.ts`, `work.ts`, `audit.ts`, `index.ts`
- Create: `packages/core/src/redact/redact.ts`, `packages/core/src/redact/redact.test.ts`
- Create: `fixtures/claude-home/**`, `fixtures/codex-home/**`, `fixtures/README.md`, `scripts/check-fixtures-redacted.mjs`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every type in `plan/00-contracts.md` §4 (exact names), `emptyUsage()`, `redact(text: string): string`, `REDACTION_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }>`, and the fixture tree listed in contracts §9.

- [ ] **Step 1: Write the types**

Copy the §4 block from `plan/00-contracts.md` exactly, split across files like this:
- `types/session.ts`: `Source`, `Availability`, `LiveStatus`, `Stage`, `Ownership`, `Usage`, `emptyUsage`, `PrRef`, `TestResult`, `Session`, `LiveState`, `AgentNode`, `Project`
- `types/events.ts`: `EventKind`, `TimelineEvent`
- `types/inbox.ts`: `InboxKind`, `InboxState`, `InboxItem`
- `types/work.ts`: `GoalState`, `Goal`, `Handoff`, `Worktree`, `Checkpoint`, `StreamStage`, `WorkStream`
- `types/audit.ts`: `AuditActor`, `AuditEntry`

`types/index.ts`
```ts
export * from './session.ts';
export * from './events.ts';
export * from './inbox.ts';
export * from './work.ts';
export * from './audit.ts';
```

`packages/core/src/index.ts`
```ts
export const CORE_VERSION = '0.0.0';
export * from './types/index.ts';
export * from './redact/redact.ts';
```

- [ ] **Step 2: Write the failing redaction test**

`packages/core/src/redact/redact.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { redact } from './redact.ts';

describe('redact', () => {
  it.each([
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end', 'token «redacted:github» end'],
    ['key github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'key «redacted:github»'],
    ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', '«redacted:anthropic»'],
    ['xoxp-1234-5678-abcd', '«redacted:slack»'],
    ['AKIAABCDEFGHIJKLMNOP', '«redacted:aws»'],
    ['postgres://admin:hunter2@db.internal:5432/app', 'postgres://«redacted:credentials»@db.internal:5432/app'],
    ['PGPASSWORD=hunter2 psql', 'PGPASSWORD=«redacted:secret» psql'],
    ['--password=hunter2', '--password=«redacted:secret»'],
    ['Authorization: Bearer eyJhbGciOi.xyz.abc', 'Authorization: Bearer «redacted:bearer»'],
  ])('redacts %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('leaves normal text alone', () => {
    const text = 'fix SAF-1787 in wakecap-wecare-service; ran pnpm test';
    expect(redact(text)).toBe(text);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/redact`
Expected: FAIL, `Cannot find module './redact.ts'`

- [ ] **Step 4: Implement redaction**

`packages/core/src/redact/redact.ts`
```ts
export interface RedactionPattern {
  kind: string;
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const tag = (kind: string) => `«redacted:${kind}»`;

export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
  { kind: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: () => tag('github') },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => tag('github') },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: () => tag('anthropic') },
  { kind: 'openai', re: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: () => tag('openai') },
  { kind: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{6,}/g, replace: () => tag('slack') },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => tag('aws') },
  {
    kind: 'credentials',
    re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/)[^\s:@/]+:[^\s@/]+@/g,
    replace: (_m, scheme) => `${scheme}${tag('credentials')}@`,
  },
  {
    kind: 'bearer',
    re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: (_m, prefix) => `${prefix}${tag('bearer')}`,
  },
  {
    kind: 'secret',
    re: /\b((?:[A-Z_]*PASSWORD|passwd|pwd|password|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;]+)/gi,
    replace: (_m, prefix) => `${prefix}${tag('secret')}`,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const p of REDACTION_PATTERNS) {
    out = out.replace(p.re, p.replace as (substring: string, ...args: string[]) => string);
  }
  return out;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/redact`
Expected: PASS (10 tests)

- [ ] **Step 6: Create the fixtures**

Create `fixtures/claude-home/` with the files below. All content is made up. Timestamps are on 2026-09-01. The fake home user is `/Users/test`. Each `.jsonl` line is one JSON object.

`fixtures/claude-home/projects/-Users-test-Wakecap/s-basic.jsonl`
```jsonl
{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"s-basic"}
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:00:00.000Z","cwd":"/Users/test/Wakecap","gitBranch":"HEAD","version":"2.1.273","entrypoint":"cli","userType":"external","message":{"role":"user","content":"check the notification service tests"},"promptId":"p1","permissionMode":"bypassPermissions"}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:00:05.000Z","cwd":"/Users/test/Wakecap","gitBranch":"HEAD","version":"2.1.273","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Running the tests."},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"pnpm vitest run","description":"Run tests"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}},"requestId":"r1"}
{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:00:30.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":" Test Files  3 passed (3)\n      Tests  18 passed (18)\n   Duration  1.40s"}]},"toolUseResult":{"stdout":" Tests  18 passed (18)"},"sourceToolAssistantUUID":"a1"}
{"type":"assistant","uuid":"a2","parentUuid":"u2","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:00:35.000Z","cwd":"/Users/test/Wakecap","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"tu2","name":"Edit","input":{"file_path":"/Users/test/Wakecap/Backend/svc/a.ts","old_string":"a","new_string":"b"}}],"usage":{"input_tokens":5,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":1100}}}
{"type":"assistant","uuid":"a2b","parentUuid":"a2","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:00:35.500Z","cwd":"/Users/test/Wakecap","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Edited."}],"usage":{"input_tokens":5,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":1100}},"apiBlockIndex":1}
{"type":"system","subtype":"turn_duration","uuid":"sy1","parentUuid":"a2b","sessionId":"s-basic","timestamp":"2026-09-01T09:00:36.000Z","durationMs":36000,"messageCount":5}
{"type":"user","uuid":"u3","parentUuid":"sy1","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:05:00.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"continue"}}
{"type":"user","uuid":"u3m","parentUuid":"u3","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:05:00.100Z","cwd":"/Users/test/Wakecap","isMeta":true,"message":{"role":"user","content":"<system-reminder>meta</system-reminder>"}}
{"type":"user","uuid":"u4","parentUuid":"u3m","isSidechain":false,"sessionId":"s-basic","timestamp":"2026-09-01T09:06:00.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"/review the change"}}
{"type":"ai-title","aiTitle":"Notification service test check","sessionId":"s-basic"}
{"type":"last-prompt","lastPrompt":"/review the change","leafUuid":"u4","sessionId":"s-basic"}
{"type":"system","subtype":"away_summary","uuid":"sy2","parentUuid":"u4","sessionId":"s-basic","timestamp":"2026-09-01T09:07:00.000Z","content":"Ran tests (18 passed) and edited a.ts."}
{"type":"cost-state","sessionId":"s-basic","totalCostUSD":0.42,"totalDuration":420000,"totalAPIDuration":60000,"totalToolDuration":30000,"totalLinesAdded":1,"totalLinesRemoved":1,"startTime":"2026-09-01T09:00:00.000Z","modelUsage":{"claude-opus-5":{"inputTokens":15,"outputTokens":27,"cacheReadInputTokens":2100,"cacheCreationInputTokens":100,"costUSD":0.42}}}
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-prlink.jsonl`
```jsonl
{"type":"user","uuid":"p-u1","parentUuid":null,"isSidechain":false,"sessionId":"s-prlink","timestamp":"2026-09-02T10:00:00.000Z","cwd":"/Users/test/Wakecap","gitBranch":"HEAD","message":{"role":"user","content":"implement SAF-1787 exclude weekends from SLA deadline using /conductor"}}
{"type":"assistant","uuid":"p-a1","parentUuid":"p-u1","isSidechain":false,"sessionId":"s-prlink","timestamp":"2026-09-02T10:00:10.000Z","cwd":"/Users/test/Wakecap/Backend/wakecap-wecare-service","message":{"id":"pm1","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"ptu1","name":"Skill","input":{"skill":"conductor","args":"SAF-1787"}},{"type":"tool_use","id":"ptu2","name":"Bash","input":{"command":"git checkout -b feat/SAF-1787-exclude-weekends-sla-deadline"}},{"type":"tool_use","id":"ptu3","name":"mcp__claude_ai_Linear__save_issue","input":{"id":"SAF-1787","state":"In Progress"}}],"usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"attributionSkill":"conductor"}
{"type":"pr-link","prNumber":231,"prUrl":"https://github.com/example-org/wakecap-wecare-service/pull/231","prRepository":"example-org/wakecap-wecare-service","sessionId":"s-prlink"}
{"type":"agent-name","agentName":"SAF-1787 SLA weekends","sessionId":"s-prlink"}
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-drift.jsonl`
```jsonl
{"type":"user","uuid":"d-u1","parentUuid":null,"isSidechain":false,"sessionId":"s-drift","timestamp":"2026-09-03T08:00:00.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"look at the svc repo"}}
{"type":"assistant","uuid":"d-a1","parentUuid":"d-u1","isSidechain":false,"sessionId":"s-drift","timestamp":"2026-09-03T08:00:05.000Z","cwd":"/Users/test/Wakecap/Backend/svc","message":{"id":"dm1","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"dtu1","name":"Bash","input":{"command":"PGPASSWORD=hunter2 psql -h prod-db.internal -c 'select 1'"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"assistant","uuid":"d-a2","parentUuid":"d-a1","isSidechain":false,"sessionId":"s-drift","timestamp":"2026-09-03T08:00:09.000Z","cwd":"/Users/test/Wakecap/Frontend/app","message":{"id":"dm2","role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"dtu2","name":"Skill","input":{"skill":"production_server_db"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-errors.jsonl` (the last line is **deliberately cut off**; write the file with no trailing newline)
```jsonl
{"type":"user","uuid":"e-u1","parentUuid":null,"isSidechain":false,"sessionId":"s-errors","timestamp":"2026-09-04T08:00:00.000Z","cwd":"/Users/test/Forza","message":{"role":"user","content":"retry"}}
{"type":"assistant","uuid":"e-a1","parentUuid":"e-u1","isSidechain":false,"sessionId":"s-errors","timestamp":"2026-09-04T08:00:01.000Z","cwd":"/Users/test/Forza","isApiErrorMessage":true,"message":{"id":"em1","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 overloaded"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"assistant","uuid":"e-a2","parentUuid":"e-a1","isSidechain":false,"sessionId":"s-errors","timestamp":"2026-09-04T08:00:0
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-unknown.jsonl`
```jsonl
{"type":"user","uuid":"k-u1","parentUuid":null,"isSidechain":false,"sessionId":"s-unknown","timestamp":"2026-09-05T08:00:00.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"hello"}}
{"type":"future-record-kind","foo":1,"sessionId":"s-unknown"}
{"type":"queue-operation","operation":"enqueue","sessionId":"s-unknown"}
{"type":"file-history-snapshot","messageId":"x","snapshot":{}}
{"type":"atis-latch","sessionId":"s-unknown"}
{"type":"bridge-session","bridgeSessionId":"b-1","sessionId":"s-unknown"}
{"type":"frame-link","path":"/tmp/x.html","frameUrl":"https://example.test/a","title":"Artifact","sessionId":"s-unknown"}
this line is not json
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-subagents.jsonl`
```jsonl
{"type":"user","uuid":"g-u1","parentUuid":null,"isSidechain":false,"sessionId":"s-subagents","timestamp":"2026-09-06T08:00:00.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"investigate SUPRT-1557"}}
{"type":"assistant","uuid":"g-a1","parentUuid":"g-u1","isSidechain":false,"sessionId":"s-subagents","timestamp":"2026-09-06T08:00:02.000Z","cwd":"/Users/test/Wakecap","message":{"id":"gm1","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"gtu1","name":"Agent","input":{"description":"Explore logs","subagent_type":"Explore","prompt":"find errors"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```

`fixtures/claude-home/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag1.jsonl`
```jsonl
{"type":"user","uuid":"ag1-u1","parentUuid":null,"isSidechain":true,"sessionId":"s-subagents","agentId":"ag1","timestamp":"2026-09-06T08:00:03.000Z","cwd":"/Users/test/Wakecap","message":{"role":"user","content":"find errors"}}
{"type":"assistant","uuid":"ag1-a1","parentUuid":"ag1-u1","isSidechain":true,"sessionId":"s-subagents","agentId":"ag1","timestamp":"2026-09-06T08:00:10.000Z","cwd":"/Users/test/Wakecap","message":{"id":"agm1","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"agtu1","name":"Agent","input":{"description":"Deep dive","subagent_type":"general-purpose","prompt":"x"}}],"usage":{"input_tokens":2,"output_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":50}}}
```
`…/subagents/agent-ag1.meta.json`
```json
{"agentType":"Explore","description":"Explore logs","toolUseId":"gtu1","parentAgentId":null,"spawnDepth":1,"requestShape":"background","requestNonInteractive":true}
```
`…/subagents/agent-ag2.jsonl`
```jsonl
{"type":"assistant","uuid":"ag2-a1","parentUuid":null,"isSidechain":true,"sessionId":"s-subagents","agentId":"ag2","timestamp":"2026-09-06T08:00:12.000Z","cwd":"/Users/test/Wakecap","message":{"id":"agm2","role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"agtu2","name":"Agent","input":{"description":"Leaf","subagent_type":"general-purpose","prompt":"y"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```
`…/subagents/agent-ag2.meta.json`
```json
{"agentType":"general-purpose","description":"Deep dive","toolUseId":"agtu1","parentAgentId":"ag1","spawnDepth":2,"requestNonInteractive":true}
```
`…/subagents/agent-ag3.jsonl`
```jsonl
{"type":"assistant","uuid":"ag3-a1","parentUuid":null,"isSidechain":true,"sessionId":"s-subagents","agentId":"ag3","timestamp":"2026-09-06T08:00:14.000Z","cwd":"/Users/test/Wakecap","message":{"id":"agm3","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```
`…/subagents/agent-ag3.meta.json`
```json
{"agentType":"general-purpose","description":"Leaf","toolUseId":"agtu2","parentAgentId":"ag2","spawnDepth":3,"requestNonInteractive":true}
```

`fixtures/claude-home/history.jsonl`
```jsonl
{"display":"old session from december","pastedContents":{},"timestamp":"1766650000000","project":"/Users/test/Wakecap","sessionId":"s-old-prompts-only"}
{"display":"check the notification service tests","pastedContents":{},"timestamp":"1788253200000","project":"/Users/test/Wakecap","sessionId":"s-basic"}
{"display":"continue","pastedContents":{},"timestamp":"1788253500000","project":"/Users/test/Wakecap","sessionId":"s-basic"}
{"display":"/long-scan","pastedContents":{},"timestamp":"1788253600000","project":"/Users/test/Stocks/EGX Investment Research","sessionId":"s-stocks"}
```

`fixtures/claude-home/sessions/41001.json`
```json
{"pid":41001,"pidDomain":"host","procStart":"Mon Sep  1 09:00:00 2026","sessionId":"s-basic","cwd":"/Users/test/Wakecap","startedAt":1788253200000,"version":"2.1.273","kind":"interactive","entrypoint":"cli","name":"notification-tests","nameSource":"auto","nameSince":1788253200000,"status":"waiting","waitingFor":"input needed","updatedAt":1788253600000,"statusUpdatedAt":1788253600000,"messagingSocketPath":"/tmp/cc-socks/41001.sock","peerProtocol":1,"peerFeatures":[]}
```

`fixtures/claude-home/usage-data/facets/s-basic.json`
```json
{"session_id":"s-basic","goal_categories":{"debugging":1},"outcome":"fully_achieved","friction_counts":{},"brief_summary":"Ran tests and fixed a.ts"}
```

`fixtures/claude-home/plans/fixture-plan.md`
```markdown
# Plan: SAF-1787 exclude weekends
Context: fixture plan.
```

`fixtures/codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl`
```jsonl
{"timestamp":"2026-09-01T09:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"c0dex000-0000-0000-0000-000000000001","session_id":"c0dex000-0000-0000-0000-000000000001","cwd":"/Users/test/Wakecap","cli_version":"0.152.1","model_provider":"openai","originator":"codex_exec","source":"exec","base_instructions":"LONG TEXT SKIPPED"}}
{"timestamp":"2026-09-01T09:00:01.000Z","ordinal":1,"type":"turn_context","payload":{"model":"gpt-5.5-codex"}}
{"timestamp":"2026-09-01T09:00:02.000Z","ordinal":2,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second opinion on SAF-1787 plan"}]}}
{"timestamp":"2026-09-01T09:00:05.000Z","ordinal":3,"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"rg\",\"weekend\"]}","call_id":"c1"}}
{"timestamp":"2026-09-01T09:00:06.000Z","ordinal":4,"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"3 matches"}}
{"timestamp":"2026-09-01T09:00:09.000Z","ordinal":5,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Plan looks fine."}]}}
{"timestamp":"2026-09-01T09:00:10.000Z","ordinal":6,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":90,"reasoning_output_tokens":30,"total_tokens":1290}}}}
{"timestamp":"2026-09-01T09:00:11.000Z","ordinal":7,"type":"event_msg","payload":{"type":"task_complete"}}
```

`fixtures/codex-home/sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl`
```jsonl
{"timestamp":"2026-03-10T09:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"c0dex000-0000-0000-0000-000000000002","session_id":"c0dex000-0000-0000-0000-000000000002","cwd":"/Users/test/hackathon","cli_version":"0.110.0","model_provider":"openai","originator":"codex_sdk_ts","source":"sdk"}}
{"timestamp":"2026-03-10T09:00:02.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"automated task"}]}}
```

`fixtures/README.md`
```markdown
# Fixtures
All content is made up and redacted. Layout mirrors `~/.claude` and `~/.codex` (see docs/04-data-sources.md).
Tests copy these into a temp dir and point CLAUDE_HOME / CODEX_HOME at the copy — never mutate in place.
`s-errors.jsonl` intentionally ends with a truncated line; `s-unknown.jsonl` intentionally contains unknown types and a non-JSON line.
The only intentional secret-like strings are the fake `PGPASSWORD=hunter2` in `s-drift.jsonl` (used by redaction tests).
```

- [ ] **Step 7: Add the fixture-redaction guard**

`scripts/check-fixtures-redacted.mjs`
```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = ['PGPASSWORD=hunter2'];
const BAD = [
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_/, /sk-ant-/, /xox[abposr]-/, /AKIA[0-9A-Z]{16}/,
  /\/Users\/hazem/, /wakecap\.com/i, /amazonaws\.com/,
];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
for (const file of walk('fixtures')) {
  let text = readFileSync(file, 'utf8');
  for (const a of ALLOW) text = text.replaceAll(a, '');
  for (const re of BAD) if (re.test(text)) problems.push(`${file}: matches ${re}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('fixtures clean');
```

Run: `pnpm check:fixtures`
Expected: `fixtures clean`

- [ ] **Step 8: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:fixtures`
Expected: everything passes.

```bash
git add -A
git commit -m "feat(core): add domain types, redaction and redacted fixtures"
```

---

### Task 3: JSONL tailer and Claude record classifier

**Files:**
- Create: `packages/core/src/io/jsonl-tail.ts`, `packages/core/src/io/jsonl-tail.test.ts`
- Create: `packages/core/src/claude/records.ts`, `packages/core/src/claude/records.test.ts`
- Create: `packages/core/src/test-utils/fixtures.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: the fixture tree from Task 2
- Produces:
  ```ts
  // io/jsonl-tail.ts
  export interface TailResult { lines: Array<{ offset: number; text: string }>; nextOffset: number; partial: boolean }
  export function readJsonlFrom(path: string, offset: number, maxBytes?: number): Promise<TailResult>
  export function parseJsonLine(text: string): unknown | undefined      // undefined when not JSON
  // claude/records.ts
  export type ClaudeRecordClass =
    | { kind: 'human_prompt'; rec: ClaudeMessageRecord; text: string }
    | { kind: 'tool_result'; rec: ClaudeMessageRecord }
    | { kind: 'meta'; rec: ClaudeMessageRecord }
    | { kind: 'assistant'; rec: ClaudeMessageRecord }
    | { kind: 'system'; rec: ClaudeMessageRecord; subtype: string | null }
    | { kind: 'attachment'; rec: ClaudeMessageRecord }
    | { kind: 'session_meta'; type: SessionMetaType; rec: Record<string, unknown> }
    | { kind: 'ignored'; type: string }
    | { kind: 'unknown'; type: string | null };
  export type SessionMetaType = 'agent-name' | 'ai-title' | 'last-prompt' | 'permission-mode' | 'mode' | 'pr-link' | 'bridge-session' | 'frame-link' | 'cost-state' | 'summary' | 'custom-title';
  export interface ClaudeMessageRecord { type: string; uuid: string; parentUuid: string | null; isSidechain?: boolean; sessionId: string; agentId?: string; timestamp: string; cwd?: string; gitBranch?: string; version?: string; isMeta?: boolean; isApiErrorMessage?: boolean; toolUseResult?: unknown; attributionSkill?: string; apiBlockIndex?: number; subtype?: string; durationMs?: number; content?: unknown; message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> } }
  export function classifyClaudeRecord(value: unknown): ClaudeRecordClass
  export function contentText(content: unknown): string        // joins text blocks; string passthrough
  // test-utils/fixtures.ts
  export const FIXTURES_DIR: string                            // absolute path to /fixtures
  ```

- [ ] **Step 1: Write the failing tailer test**

`packages/core/src/test-utils/fixtures.ts`
```ts
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));
```

`packages/core/src/io/jsonl-tail.test.ts`
```ts
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { parseJsonLine, readJsonlFrom } from './jsonl-tail.ts';

describe('readJsonlFrom', () => {
  it('reads complete lines and reports a partial trailing line', async () => {
    const r = await readJsonlFrom(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-errors.jsonl'), 0);
    expect(r.lines).toHaveLength(2);
    expect(r.partial).toBe(true);
    expect(r.nextOffset).toBeLessThan(
      Buffer.byteLength(
        (await import('node:fs')).readFileSync(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-errors.jsonl')),
      ),
    );
  });

  it('resumes from an offset and only returns new lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-tail-'));
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const first = await readJsonlFrom(f, 0);
    expect(first.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"n":2}']);
    appendFileSync(f, '{"n":3}\n{"n":');
    const second = await readJsonlFrom(f, first.nextOffset);
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":3}']);
    expect(second.partial).toBe(true);
    appendFileSync(f, '4}\n');
    const third = await readJsonlFrom(f, second.nextOffset);
    expect(third.lines.map((l) => l.text)).toEqual(['{"n":4}']);
    expect(third.partial).toBe(false);
  });

  it('handles multi-byte characters across chunk boundaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-tail-'));
    const f = join(dir, 'u.jsonl');
    const line = JSON.stringify({ t: 'مرحبا'.repeat(50) });
    writeFileSync(f, `${line}\n${line}\n`);
    const r = await readJsonlFrom(f, 0, 64);
    expect(r.lines.map((l) => l.text)).toEqual([line, line]);
  });
});

describe('parseJsonLine', () => {
  it('returns undefined for non-JSON', () => {
    expect(parseJsonLine('this line is not json')).toBeUndefined();
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/io`
Expected: FAIL, `Cannot find module './jsonl-tail.ts'`

- [ ] **Step 3: Implement the tailer**

`packages/core/src/io/jsonl-tail.ts`
```ts
import { open } from 'node:fs/promises';

export interface TailResult {
  lines: Array<{ offset: number; text: string }>;
  nextOffset: number;
  partial: boolean;
}

const NL = 0x0a;

/**
 * Reads complete newline-terminated lines starting at `offset`.
 * A trailing line without "\n" is not returned; `nextOffset` stays at its start so the next call re-reads it.
 * `maxBytes` is the read chunk size (small values are used in tests).
 */
export async function readJsonlFrom(path: string, offset: number, maxBytes = 1 << 20): Promise<TailResult> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const lines: TailResult['lines'] = [];
    let pos = offset;
    let carry = Buffer.alloc(0);
    let carryStart = offset;
    while (pos < size) {
      const len = Math.min(maxBytes, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead === 0) break;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NL) {
          const text = chunk.subarray(start, i).toString('utf8').replace(/\r$/, '');
          if (text.length > 0) lines.push({ offset: carryStart + start, text });
          start = i + 1;
        }
      }
      carryStart += start;
      carry = Buffer.from(chunk.subarray(start));
      pos += bytesRead;
    }
    return { lines, nextOffset: carryStart, partial: carry.length > 0 };
  } finally {
    await fh.close();
  }
}

export function parseJsonLine(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tailer test and confirm it passes**

Run: `pnpm vitest run packages/core/src/io`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing classifier test**

`packages/core/src/claude/records.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { classifyClaudeRecord, contentText } from './records.ts';

const load = (name: string) =>
  readFileSync(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseJsonLine);

describe('classifyClaudeRecord', () => {
  it('classifies the basic session', () => {
    const kinds = load('s-basic.jsonl').map((v) => classifyClaudeRecord(v).kind);
    expect(kinds).toEqual([
      'session_meta', 'human_prompt', 'assistant', 'tool_result', 'assistant', 'assistant',
      'system', 'human_prompt', 'meta', 'human_prompt', 'session_meta', 'session_meta', 'system', 'session_meta',
    ]);
  });

  it('extracts human prompt text', () => {
    const c = classifyClaudeRecord(load('s-basic.jsonl')[1]);
    expect(c.kind === 'human_prompt' && c.text).toBe('check the notification service tests');
  });

  it('marks known noise as ignored and new types as unknown', () => {
    const out = load('s-unknown.jsonl').map((v) => classifyClaudeRecord(v));
    expect(out.map((c) => c.kind)).toEqual([
      'human_prompt', 'unknown', 'ignored', 'ignored', 'ignored', 'session_meta', 'session_meta', 'unknown',
    ]);
    expect(out[1]).toEqual({ kind: 'unknown', type: 'future-record-kind' });
    expect(out[7]).toEqual({ kind: 'unknown', type: null });
  });

  it('exposes session meta type', () => {
    const c = classifyClaudeRecord(load('s-prlink.jsonl')[2]);
    expect(c.kind === 'session_meta' && c.type).toBe('pr-link');
  });
});

describe('contentText', () => {
  it('joins text blocks and passes strings through', () => {
    expect(contentText('hi')).toBe('hi');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(contentText(undefined)).toBe('');
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/claude`
Expected: FAIL, `Cannot find module './records.ts'`

- [ ] **Step 7: Implement the classifier**

`packages/core/src/claude/records.ts`
```ts
export type SessionMetaType =
  | 'agent-name' | 'ai-title' | 'last-prompt' | 'permission-mode' | 'mode' | 'pr-link'
  | 'bridge-session' | 'frame-link' | 'cost-state' | 'summary' | 'custom-title';

export interface ClaudeMessageRecord {
  type: string;
  uuid: string;
  parentUuid: string | null;
  isSidechain?: boolean;
  sessionId: string;
  agentId?: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  toolUseResult?: unknown;
  attributionSkill?: string;
  apiBlockIndex?: number;
  subtype?: string;
  durationMs?: number;
  content?: unknown;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> };
}

export type ClaudeRecordClass =
  | { kind: 'human_prompt'; rec: ClaudeMessageRecord; text: string }
  | { kind: 'tool_result'; rec: ClaudeMessageRecord }
  | { kind: 'meta'; rec: ClaudeMessageRecord }
  | { kind: 'assistant'; rec: ClaudeMessageRecord }
  | { kind: 'system'; rec: ClaudeMessageRecord; subtype: string | null }
  | { kind: 'attachment'; rec: ClaudeMessageRecord }
  | { kind: 'session_meta'; type: SessionMetaType; rec: Record<string, unknown> }
  | { kind: 'ignored'; type: string }
  | { kind: 'unknown'; type: string | null };

const SESSION_META = new Set<string>([
  'agent-name', 'ai-title', 'last-prompt', 'permission-mode', 'mode', 'pr-link',
  'bridge-session', 'frame-link', 'cost-state', 'summary', 'custom-title',
]);
const IGNORED = new Set<string>([
  'queue-operation', 'file-history-snapshot', 'file-history-delta', 'atis-latch',
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result');
}

export function classifyClaudeRecord(value: unknown): ClaudeRecordClass {
  if (!isObj(value)) return { kind: 'unknown', type: null };
  const type = typeof value.type === 'string' ? value.type : null;
  if (type === null) return { kind: 'unknown', type: null };
  if (SESSION_META.has(type)) return { kind: 'session_meta', type: type as SessionMetaType, rec: value };
  if (IGNORED.has(type) || type.startsWith('artifact-')) return { kind: 'ignored', type };

  const rec = value as unknown as ClaudeMessageRecord;
  switch (type) {
    case 'user': {
      if (rec.toolUseResult !== undefined || hasToolResultBlock(rec.message?.content)) return { kind: 'tool_result', rec };
      if (rec.isMeta === true) return { kind: 'meta', rec };
      return { kind: 'human_prompt', rec, text: contentText(rec.message?.content) };
    }
    case 'assistant':
      return { kind: 'assistant', rec };
    case 'system':
      return { kind: 'system', rec, subtype: typeof rec.subtype === 'string' ? rec.subtype : null };
    case 'attachment':
      return { kind: 'attachment', rec };
    default:
      return { kind: 'unknown', type };
  }
}
```

`packages/core/src/index.ts` (add the exports)
```ts
export const CORE_VERSION = '0.0.0';
export * from './types/index.ts';
export * from './redact/redact.ts';
export * from './io/jsonl-tail.ts';
export * from './claude/records.ts';
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests)

- [ ] **Step 9: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add -A
git commit -m "feat(core): add incremental JSONL tailer and Claude record classifier"
```

---

### Task 4: api-contract package, and daemon and web shells

**Files:**
- Create: `packages/api-contract/{package.json,tsconfig.json,vitest.config.ts}`, `packages/api-contract/src/{index.ts,config.ts,errors.ts,config.test.ts}`
- Create: `apps/daemon/{package.json,tsconfig.json,vitest.config.ts}`, `apps/daemon/src/main.ts`, `apps/daemon/src/main.test.ts`
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,vitest.config.ts}`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `@orc/core`
- Produces: `OrcConfig`, `ProjectConfig` (zod, exactly as in contracts §3); `ApiError` zod and `apiError(code, message, details?)`; daemon export `createHealthApp()` (a Hono app with `GET /api/health`); a web app shell that renders "Orchestrator".

- [ ] **Step 1: Create the api-contract package**

`packages/api-contract/package.json`
```json
{
  "name": "@orc/api-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "@orc/core": "workspace:*", "zod": "^4.6.5" }
}
```
`packages/api-contract/tsconfig.json`: the same as the core one. `packages/api-contract/vitest.config.ts`: the same as core's, but with `name: 'api-contract'`.

`packages/api-contract/src/errors.ts`
```ts
import { z } from 'zod';

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export function apiError(code: string, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
```

`packages/api-contract/src/config.ts`: copy the zod block from `plan/00-contracts.md` §3 exactly (`ProjectConfig`, `OrcConfig` and both types), with `import { z } from 'zod';` at the top.

`packages/api-contract/src/index.ts`
```ts
export * from './config.ts';
export * from './errors.ts';
```

- [ ] **Step 2: Write the failing config test**

`packages/api-contract/src/config.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { OrcConfig } from './config.ts';

describe('OrcConfig', () => {
  it('fills defaults from an empty object', () => {
    const c = OrcConfig.parse({});
    expect(c.port).toBe(4317);
    expect(c.defaultProjectId).toBe('wakecap');
    expect(c.resumeProfile.claudeArgs).toEqual(['--dangerously-skip-permissions']);
    expect(c.recaps.autoModel).toBe('claude-haiku-4-5');
    expect(c.recaps.onDemandModel).toBe('claude-sonnet-5');
    expect(c.codex.showAutomated).toBe(false);
  });

  it('fills project defaults', () => {
    const c = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/Users/test/Wakecap'] }] });
    expect(c.projects[0]?.maxConcurrentOwned).toBe(6);
    expect(c.projects[0]?.features.workStreams).toBe(false);
  });
});
```

Run: `pnpm install && pnpm vitest run packages/api-contract`
Expected: PASS. If it fails, fix `config.ts` so that it matches contracts §3. With zod 4, nested `.default({})` needs the inner object to have defaults on every field, which the contract already provides.

- [ ] **Step 3: Create the daemon shell with a health test**

`apps/daemon/package.json`
```json
{
  "name": "@orc/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsup src/main.ts --format esm --platform node --target node22 --out-dir dist",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.1",
    "@orc/api-contract": "workspace:*",
    "@orc/core": "workspace:*",
    "hono": "^4.13.8"
  },
  "devDependencies": { "tsup": "^8.5.1", "tsx": "^4.23.13" }
}
```
`apps/daemon/tsconfig.json`: the same as core's, with `"include": ["src", "test"]`. `apps/daemon/vitest.config.ts`: the same pattern, with `name: 'daemon'` and `include: ['src/**/*.test.ts', 'test/**/*.test.ts']`.

`apps/daemon/src/main.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { createHealthApp } from './main.ts';

describe('health', () => {
  it('returns ok', async () => {
    const res = await createHealthApp().request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.0.0');
  });
});
```

`apps/daemon/src/main.ts`
```ts
import { serve } from '@hono/node-server';
import { CORE_VERSION } from '@orc/core';
import { Hono } from 'hono';

const startedAt = Date.now();

export function createHealthApp(): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: CORE_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.ORC_PORT ?? 4317);
  serve({ fetch: createHealthApp().fetch, port, hostname: '127.0.0.1' });
  console.log(`orchestrator daemon on http://127.0.0.1:${port}`);
}
```

Run: `pnpm install && pnpm vitest run apps/daemon`
Expected: PASS (1 test)

- [ ] **Step 4: Create the web shell with a render test**

`apps/web/package.json`
```json
{
  "name": "@orc/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": { "react": "^19.3.0", "react-dom": "^19.3.0" },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^27.0.0",
    "tailwindcss": "^4.3.3",
    "vite": "^8.3.0"
  }
}
```
Before installing, run `npm view @vitejs/plugin-react version`, `npm view @testing-library/react version` and `npm view jsdom version`, and use the current majors if they differ from the ones above.

`apps/web/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "types": ["vite/client"], "paths": { "@/*": ["./src/*"] } },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`
```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4317', '/ws': { target: 'ws://127.0.0.1:4317', ws: true }, '/pty': { target: 'ws://127.0.0.1:4317', ws: true } } },
});
```

`apps/web/vitest.config.ts`
```ts
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { name: 'web', environment: 'jsdom', include: ['src/**/*.test.tsx', 'src/**/*.test.ts'] },
});
```

`apps/web/index.html`
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Orchestrator</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/web/src/App.test.tsx`
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('App', () => {
  it('renders the product name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Orchestrator' })).toBeDefined();
  });
});
```

`apps/web/src/App.tsx`
```tsx
export function App() {
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Orchestrator</h1>
    </main>
  );
}
```

`apps/web/src/main.tsx`
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/index.css`
```css
@import "tailwindcss";
```

Run: `pnpm install && pnpm vitest run apps/web && pnpm --filter @orc/web build`
Expected: the test passes and the Vite build writes `apps/web/dist/`.

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add -A
git commit -m "chore(repo): add api-contract, daemon and web shells"
```

---

### Task 5: Spike S1 — parser dry-run over the real `~/.claude`

**Files:**
- Create: `spikes/s1-parser-dryrun/dryrun.ts`
- Create: `plan/spikes/S1.md`

**Interfaces:**
- Consumes: `readJsonlFrom`, `parseJsonLine`, `classifyClaudeRecord` from `@orc/core`
- Produces: a report of the counts for each record class, the list of unknown types, parse failures and runtime. This is the **go/no-go for the parser approach**.

- [ ] **Step 1: Write the dry-run script (read-only)**

`spikes/s1-parser-dryrun/dryrun.ts`
```ts
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyClaudeRecord, parseJsonLine, readJsonlFrom } from '@orc/core';

const root = join(process.env.CLAUDE_HOME ?? join(homedir(), '.claude'), 'projects');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) return walk(p);
    return p.endsWith('.jsonl') ? [p] : [];
  });
}

const t0 = performance.now();
const files = walk(root);
const counts = new Map<string, number>();
const unknownTypes = new Map<string, number>();
let lines = 0;
let badJson = 0;
let partial = 0;
let bytes = 0;
const sessions = new Set<string>();
const prs = new Set<string>();
let subagentFiles = 0;
let costSum = 0;
const lastCost = new Map<string, number>();

for (const f of files) {
  if (f.includes('/subagents/')) subagentFiles++;
  bytes += statSync(f).size;
  const r = await readJsonlFrom(f, 0);
  if (r.partial) partial++;
  for (const l of r.lines) {
    lines++;
    const v = parseJsonLine(l.text);
    if (v === undefined) {
      badJson++;
      continue;
    }
    const c = classifyClaudeRecord(v);
    const key = c.kind === 'session_meta' ? `session_meta:${c.type}` : c.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (c.kind === 'unknown') unknownTypes.set(String(c.type), (unknownTypes.get(String(c.type)) ?? 0) + 1);
    if (c.kind === 'human_prompt' && !f.includes('/subagents/')) sessions.add(c.rec.sessionId);
    if (c.kind === 'session_meta' && c.type === 'pr-link') prs.add(String(c.rec.prUrl));
    if (c.kind === 'session_meta' && c.type === 'cost-state' && !f.includes('/subagents/')) {
      lastCost.set(f, Number(c.rec.totalCostUSD ?? 0));
    }
  }
}
for (const v of lastCost.values()) costSum += v;

console.log(JSON.stringify({
  files: files.length, subagentFiles, mainSessionsWithPrompts: sessions.size, bytes, lines, badJson, partialFiles: partial,
  distinctPrs: prs.size, costFromCostState: Math.round(costSum), ms: Math.round(performance.now() - t0),
  counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
  unknownTypes: Object.fromEntries(unknownTypes),
}, null, 2));
```

- [ ] **Step 2: Run it against the real data**

Run: `pnpm dlx tsx spikes/s1-parser-dryrun/dryrun.ts > /tmp/s1.json; cat /tmp/s1.json`
Expected: JSON output, finishing in under 60 s. The numbers should be close to docs/01: about 150 main sessions, about 760 subagent files, about 246 PRs and about $4.7k. Transcripts roll off after 30 days, so the numbers will have moved; the order of magnitude is what matters.

- [ ] **Step 3: Write the spike report**

`plan/spikes/S1.md`: fill in every field from the JSON output:
```markdown
# S1 — Parser dry-run
Date: <run date> · Claude Code version: <`claude --version`>
| metric | value |
|---|---|
| files / subagent files | … |
| main sessions with prompts | … |
| bytes / lines | … |
| bad JSON lines / partial files | … |
| distinct PRs / cost-state sum | … |
| runtime ms | … |
## Record class counts
<paste counts>
## Unknown types
<paste; for each: decide 'ignore' or 'add to SESSION_META/IGNORED' and apply in records.ts with a test>
## Decision
GO if: no crash, bad JSON < 0.1% of lines, runtime < 60 s. Otherwise list the fixes.
```

- [ ] **Step 4: Fix any unknown types the report found**

For each unknown type the report marks as known noise, add it to `IGNORED` or `SESSION_META` in `packages/core/src/claude/records.ts`. Add a matching line to `fixtures/claude-home/projects/-Users-test-Wakecap/s-unknown.jsonl`, and update the expected array in `records.test.ts` (one `'ignored'` or `'session_meta'` per added line, in the order written). Run `pnpm vitest run packages/core` and confirm it passes.

- [ ] **Step 5: Commit**

```bash
git add spikes/s1-parser-dryrun plan/spikes/S1.md packages/core fixtures
git commit -m "chore(spike): S1 parser dry-run report"
```

---

### Task 6: Spikes S2 and S8 — node-pty + xterm.js resume and scripted input

**Files:**
- Create: `spikes/s2-pty/package.json`, `spikes/s2-pty/server.ts`, `spikes/s2-pty/index.html`, `spikes/s2-pty/send-text.ts`, `spikes/s2-pty/send-text.test.ts`
- Create: `plan/spikes/S2-S8.md`

**Interfaces:**
- Consumes: nothing from the workspace
- Produces: a validated `sendText` algorithm. Phase 1 copies it into `apps/daemon/src/pty/input.ts`. Its signature:
  ```ts
  export function encodePaste(text: string): string   // "\x1b[200~" + text + "\x1b[201~"
  export async function sendText(write: (d: string) => void, text: string, opts?: { submitDelayMs?: number }): Promise<void>
  ```

- [ ] **Step 1: Create the spike package**

`spikes/s2-pty/package.json`
```json
{
  "name": "spike-s2-pty",
  "private": true,
  "type": "module",
  "dependencies": { "node-pty": "^1.1.0", "ws": "^8.21.3", "@xterm/xterm": "^6.0.0", "@xterm/addon-fit": "^0.11.0" },
  "devDependencies": { "tsx": "^4.23.13", "@types/ws": "^8.18.0" }
}
```
Run: `cd spikes/s2-pty && npm install --no-save && cd -`. Use npm here on purpose, so the spike stays outside the pnpm workspace.

- [ ] **Step 2: Write the failing test for the paste encoding**

`spikes/s2-pty/send-text.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { encodePaste, sendText } from './send-text.ts';

describe('sendText', () => {
  it('wraps text in bracketed paste', () => {
    expect(encodePaste('hi\nthere')).toBe('\x1b[200~hi\nthere\x1b[201~');
  });

  it('writes paste then carriage return', async () => {
    const writes: string[] = [];
    await sendText((d) => writes.push(d), 'yes', { submitDelayMs: 0 });
    expect(writes).toEqual(['\x1b[200~yes\x1b[201~', '\r']);
  });
});
```
Run: `pnpm vitest run spikes/s2-pty` (the root workspace config doesn't include `spikes`, so run `pnpm vitest run --root spikes/s2-pty`)
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `send-text.ts`**

`spikes/s2-pty/send-text.ts`
```ts
export function encodePaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export async function sendText(
  write: (d: string) => void,
  text: string,
  opts: { submitDelayMs?: number } = {},
): Promise<void> {
  write(encodePaste(text));
  await new Promise((r) => setTimeout(r, opts.submitDelayMs ?? 120));
  write('\r');
}
```
Run: `pnpm vitest run --root spikes/s2-pty`
Expected: PASS

- [ ] **Step 4: Write the PTY bridge server**

`spikes/s2-pty/server.ts`
```ts
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { sendText } from './send-text.ts';

const [, , sessionId, cwd] = process.argv;
if (!sessionId || !cwd) {
  console.error('usage: tsx server.ts <claudeSessionId> <originalCwd>');
  process.exit(1);
}

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.url?.startsWith('/node_modules/')) {
    res.end(readFileSync(new URL(`.${req.url}`, import.meta.url)));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(html);
});
const wss = new WebSocketServer({ server, path: '/pty' });

const pty = spawn('claude', ['--resume', sessionId, '--dangerously-skip-permissions'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 36,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
});
let scrollback = '';
pty.onData((d) => {
  scrollback = (scrollback + d).slice(-200_000);
  for (const c of wss.clients) c.send(d);
});
pty.onExit(({ exitCode }) => console.log('pty exited', exitCode));

wss.on('connection', (ws) => {
  ws.send(scrollback);
  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw)) as { t: 'in'; d: string } | { t: 'resize'; cols: number; rows: number } | { t: 'say'; text: string };
    if (msg.t === 'in') pty.write(msg.d);
    if (msg.t === 'resize') pty.resize(msg.cols, msg.rows);
    if (msg.t === 'say') await sendText((d) => pty.write(d), msg.text);
  });
});
server.listen(4399, '127.0.0.1', () => console.log('open http://127.0.0.1:4399'));
```

`spikes/s2-pty/index.html`
```html
<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css" />
    <style>html,body,#t{height:100%;margin:0;background:#111}</style>
  </head>
  <body>
    <div id="t"></div>
    <script type="module">
      import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
      import { FitAddon } from '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
      const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('t'));
      fit.fit();
      const ws = new WebSocket(`ws://${location.host}/pty`);
      ws.onmessage = (e) => term.write(e.data);
      term.onData((d) => ws.send(JSON.stringify({ t: 'in', d })));
      const sendSize = () => { fit.fit(); ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
      window.addEventListener('resize', sendSize);
      ws.onopen = sendSize;
      window.say = (text) => ws.send(JSON.stringify({ t: 'say', text }));
    </script>
  </body>
</html>
```

- [ ] **Step 5: Test it manually against a throwaway session (manual, with evidence)**

1. Create a disposable session: `cd /tmp && mkdir -p orc-spike && cd orc-spike && claude -p "say hi" --output-format json | tee /tmp/s2-session.json`. Note the `session_id` in the output.
2. Run `cd /Users/hazem/orchestrator/spikes/s2-pty && npx tsx server.ts <session_id> /tmp/orc-spike`, then open `http://127.0.0.1:4399`.
3. Check each of these and record pass or fail:

| # | Check | How |
|---|---|---|
| a | The TUI renders correctly (fullscreen mode, colours, box drawing) | Take a screenshot |
| b | Typing works | Type a prompt |
| c | Resizing reflows the TUI | Resize the browser window |
| d | Scrollback replays after a reload | Reload the page |
| e | Scripted replies arrive | In the devtools console, run `for (let i=0;i<50;i++) await new Promise(r=>setTimeout(r, 4000, say('reply with the single word ok '+i)))`. Count how many of the 50 replies arrive complete and in order. **Pass = 50/50.** |
| f | Replies wait while the session is busy | While Claude is still answering, run `say('queued text')`. Record whether it is queued or garbled. |
| g | Multi-line paste | Run `say('line1\nline2')`. Record whether it arrives as one prompt. |

- [ ] **Step 6: Write the report**

`plan/spikes/S2-S8.md`:
```markdown
# S2 + S8 — PTY rendering & scripted input
Date · claude version · node-pty version
| check | result | evidence |
|---|---|---|
| a render | pass/fail | screenshot path |
| b typing | … | |
| c resize | … | |
| d scrollback replay | … | |
| e 50 scripted replies | n/50 | |
| f send while busy | queued/garbled | |
| g multi-line | one prompt / split | |
## Decisions for Phase 1
- submitDelayMs: <value that worked>
- Need idle detection before send? <yes/no — if yes, rule: wait for registry status idle|waiting before sendText>
- Bun PTY evaluated? <optional: `bun --version`; skip unless time allows> → Node stays default
GO if a–e pass.
```

- [ ] **Step 7: Commit**

```bash
git add spikes/s2-pty plan/spikes/S2-S8.md
git commit -m "chore(spike): S2/S8 PTY resume and scripted input"
```

---

### Task 7: Spike S3 — registry status latency

**Files:**
- Create: `spikes/s3-registry/watch.ts`, `plan/spikes/S3.md`

**Interfaces:**
- Produces: a measured delay (the gap between a status change and the file event) plus a decision on whether the hook bridge is needed for the <2 s target.

- [ ] **Step 1: Write the watcher (read-only)**

`spikes/s3-registry/watch.ts`
```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'chokidar';

const dir = join(homedir(), '.claude', 'sessions');
const last = new Map<string, string>();

watch(dir, { ignored: (p) => p.endsWith('.key'), ignoreInitial: false, awaitWriteFinish: false }).on('all', (ev, path) => {
  if (!path.endsWith('.json')) return;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; status: string; statusUpdatedAt: number; waitingFor?: string };
    const prev = last.get(path);
    if (prev !== j.status) {
      const lagMs = Date.now() - j.statusUpdatedAt;
      console.log(new Date().toISOString(), ev, j.pid, `${prev ?? '-'} → ${j.status}`, j.waitingFor ?? '', `lag=${lagMs}ms`);
      last.set(path, j.status);
    }
  } catch (e) {
    console.log('parse error (partial write?)', path, String(e));
  }
});
console.log('watching', dir);
```
Run: `cd /Users/hazem/orchestrator && pnpm add -w -D chokidar@^5.0.0 && pnpm dlx tsx spikes/s3-registry/watch.ts`

- [ ] **Step 2: Measure it**

In another terminal, start `claude`, send a prompt, wait for the answer, and trigger a question (plan mode, or a prompt that asks a question). Collect at least 20 status transitions, including busy→idle and busy→waiting.

- [ ] **Step 3: Write the report and commit**

`plan/spikes/S3.md` records:
- the lag distribution (min/median/max)
- the number of partial-write parse errors
- whether `waiting` is reported
- **Decision:** use polling/watching alone if the median is under 1 s and the max under 2 s. Otherwise the hook bridge (F10) moves to Phase 2.

```bash
git add spikes/s3-registry plan/spikes/S3.md package.json pnpm-lock.yaml
git commit -m "chore(spike): S3 registry status latency"
```

---

### Task 8: Spike S5 — Codex rollouts and live processes

**Files:**
- Create: `spikes/s5-codex/probe.ts`, `plan/spikes/S5.md`

- [ ] **Step 1: Write the probe (read-only; SQLite opened with `mode=ro`)**

`spikes/s5-codex/probe.ts`
```ts
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonLine, readJsonlFrom } from '@orc/core';
import Database from 'better-sqlite3';

const home = join(homedir(), '.codex');
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [];
  });
}
const files = walk(join(home, 'sessions'));
const originators = new Map<string, number>();
const payloadTypes = new Map<string, number>();
for (const f of files.slice(-300)) {
  const r = await readJsonlFrom(f, 0);
  for (const l of r.lines) {
    const v = parseJsonLine(l.text) as { type?: string; payload?: { type?: string; originator?: string } } | undefined;
    if (!v) continue;
    const k = `${v.type}:${v.payload?.type ?? ''}`;
    payloadTypes.set(k, (payloadTypes.get(k) ?? 0) + 1);
    if (v.type === 'session_meta') originators.set(String(v.payload?.originator), (originators.get(String(v.payload?.originator)) ?? 0) + 1);
  }
}
console.log({ files: files.length, originators: Object.fromEntries(originators), payloadTypes: Object.fromEntries(payloadTypes) });

const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => /\bcodex\b/.test(l) && !l.includes('probe.ts'));
console.log('codex processes:', ps);
for (const line of ps) {
  const pid = line.trim().split(/\s+/)[0];
  if (!pid) continue;
  try {
    const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    console.log(pid, cwd.split('\n').find((x) => x.startsWith('n')));
  } catch { /* process gone */ }
}

for (const dbName of ['state_5.sqlite', 'thread_history_1.sqlite']) {
  const db = new Database(join(home, dbName), { readonly: true, fileMustExist: true });
  const tables = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
  console.log(dbName, tables.map((t) => t.name));
  for (const t of tables) {
    const cols = db.prepare(`pragma table_info(${JSON.stringify(t.name)})`).all() as { name: string }[];
    console.log('  ', t.name, cols.map((c) => c.name).join(','));
  }
  db.close();
}
```
Run: `pnpm add -w -D better-sqlite3@^13.0.3 @types/better-sqlite3 && pnpm dlx tsx spikes/s5-codex/probe.ts`
**Do not print row contents.** The probe only prints table and column names.

- [ ] **Step 2: Write the report and commit**

`plan/spikes/S5.md` covers:
- the originator distribution
- the payload types seen
- how to match a live `codex` process to a rollout: by cwd plus the newest rollout whose mtime is under 10 s old
- whether `state_5.sqlite` has thread names and status, and which table and columns hold them
- **Decision:** the rollout-only approach vs. also reading SQLite read-only.

```bash
git add spikes/s5-codex plan/spikes/S5.md package.json pnpm-lock.yaml
git commit -m "chore(spike): S5 codex rollout and process mapping"
```

---

### Task 9: Spike S6 — using Wakecore from a standalone Vite app

**Files:**
- Create: `spikes/s6-wakecore/**` (a throwaway Vite app), `plan/spikes/S6.md`

- [ ] **Step 1: Check access to the registry**

Run: `gh auth token >/dev/null && echo ok` and `GITHUB_PACKAGES_TOKEN=$(gh auth token) npm view @wakecap/core-ui@0.17 peerDependencies --registry https://npm.pkg.github.com`
Expected: the peer list prints, including react `>=18.2.0` and the heavy optional peers (`three`, `@thatopen/*`). If you get a 401/403, note in the report that the token needs the `read:packages` scope, and ask the user to run `! gh auth refresh -s read:packages`.

- [ ] **Step 2: Create a minimal app that renders a few components**

```bash
cd /Users/hazem/orchestrator/spikes && npm create vite@latest s6-wakecore -- --template react-ts && cd s6-wakecore
cp ../../.npmrc .
GITHUB_PACKAGES_TOKEN=$(gh auth token) npm install @wakecap/core-ui@^0.17.0 @wakecap/core-tokens@^0.8.0 tailwindcss @tailwindcss/vite
```
Then edit `src/App.tsx` so it renders a Button, a Badge, a Card and a Command (cmdk) component from `@wakecap/core-ui`. Use the export names from `/Users/hazem/Wakecap/Frontend/Wakecore/packages/components/src/index.ts` (read that file first). Import the tokens CSS as that package's README describes.

- [ ] **Step 3: Measure it**

Run: `npm run build 2>&1 | tail -20 && du -sh dist`

Record:
- whether the build succeeds without installing `three` or `@thatopen/*`
- the bundle size
- whether tree-shaking keeps the 3D code out: run `grep -l "three" dist/assets/*.js`
- whether the Tailwind v4 preset or tokens work (take a screenshot with `npm run dev`)

- [ ] **Step 4: Write the report and commit**

`plan/spikes/S6.md`: **GO** means using `@wakecap/core-ui` requires no 3D peers and the bundle stays under 600 kB gzip. On **NO-GO**, use shadcn/ui components copied into `apps/web/src/components/ui/`, together with Wakecore colour tokens copied into `apps/web/src/styles/tokens.css`. Either way, list which component names the `@/components/ui/*` re-export layer must provide: `Button`, `Badge`, `Card`, `Input`, `Select`, `Dialog`, `DropdownMenu`, `Tabs`, `Tooltip`, `Command`, `Table`, `Sheet`, `Separator`, `ScrollArea`, `Toggle`, `Checkbox`, `Switch`, `Popover`, `Skeleton`, `Progress`.

```bash
cd /Users/hazem/orchestrator
git add plan/spikes/S6.md spikes/s6-wakecore/src spikes/s6-wakecore/package.json
git commit -m "chore(spike): S6 wakecore consumption"
```

---

### Task 10: Spike S7 — quota and limit data source

**Files:**
- Create: `spikes/s7-quota/estimate.ts`, `plan/spikes/S7.md`

- [ ] **Step 1: Look for an official source (read-only)**

Record the answer to each:

| # | Question | How to check |
|---|---|---|
| a | Does the statusline stdin JSON include rate-limit or usage fields? | Configure a temporary statusline **in a scratch settings file only**: `claude --settings /tmp/s7-settings.json` with `{"statusLine":{"type":"command","command":"cat > /tmp/s7-statusline.json; echo s7"}}`. Start a session, send one prompt, then `cat /tmp/s7-statusline.json` and list its keys. |
| b | Does `claude /usage` or `/status` show 5-hour/weekly limits? | Run it interactively and take a screenshot. |
| c | Is there a documented source? | Check `claude --help` and the docs with the claude-code-guide agent: "Is there a programmatic way to read Claude Code subscription usage limits?" |

- [ ] **Step 2: Build the fallback estimator (the ccusage method)**

`spikes/s7-quota/estimate.ts`
```ts
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyClaudeRecord, parseJsonLine, readJsonlFrom } from '@orc/core';

const root = join(homedir(), '.claude', 'projects');
const since = Date.now() - 7 * 24 * 3600_000;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    const s = statSync(p);
    return s.isDirectory() ? walk(p) : p.endsWith('.jsonl') && s.mtimeMs > since ? [p] : [];
  });

type U = { ts: number; tokens: number; model: string };
const seen = new Set<string>();
const usages: U[] = [];
for (const f of walk(root)) {
  for (const l of (await readJsonlFrom(f, 0)).lines) {
    const c = classifyClaudeRecord(parseJsonLine(l.text));
    if (c.kind !== 'assistant') continue;
    const m = c.rec.message;
    if (!m?.id || !m.usage || seen.has(m.id) || m.model === '<synthetic>') continue;
    seen.add(m.id);
    const u = m.usage as Record<string, number>;
    usages.push({ ts: Date.parse(c.rec.timestamp), model: String(m.model), tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) });
  }
}
usages.sort((a, b) => a.ts - b.ts);
// 5h blocks: a block starts at the first message (floored to the hour) and lasts 5h
const blocks: Array<{ start: number; end: number; tokens: number; msgs: number }> = [];
for (const u of usages) {
  const b = blocks.at(-1);
  if (!b || u.ts >= b.end) {
    const start = Math.floor(u.ts / 3600_000) * 3600_000;
    blocks.push({ start, end: start + 5 * 3600_000, tokens: u.tokens, msgs: 1 });
  } else {
    b.tokens += u.tokens;
    b.msgs++;
  }
}
const current = blocks.at(-1);
console.log({
  weekTokens: usages.reduce((s, u) => s + u.tokens, 0),
  blocks: blocks.length,
  current: current && { start: new Date(current.start).toISOString(), resetsInMin: Math.round((current.end - Date.now()) / 60000), tokens: current.tokens, msgs: current.msgs },
});
```
Run: `pnpm dlx tsx spikes/s7-quota/estimate.ts`

- [ ] **Step 3: Write the report and commit**

`plan/spikes/S7.md` includes:
- the official-source findings (a–c), with the key names if any exist
- the estimator output next to what Claude's `/usage` shows at the same moment
- **Decision:** `official` (give the field path) or `estimate` (UI label "estimated"; accuracy noted)

```bash
git add spikes/s7-quota plan/spikes/S7.md
git commit -m "chore(spike): S7 quota data source"
```

---

### Task 11: Phase 0 exit check

**Files:**
- Modify: `plan/README.md` (status table), `plan/00-contracts.md` (only if a spike changed a contract)

- [ ] **Step 1: Check the exit criteria**

| Criterion | Evidence |
|---|---|
| `pnpm lint && pnpm typecheck && pnpm test` all green | command output |
| `pnpm --filter @orc/web build` and `pnpm --filter @orc/daemon build` succeed | output |
| S1 report says GO | `plan/spikes/S1.md` |
| S2/S8 report says GO (checks a–e) | `plan/spikes/S2-S8.md` |
| S3, S5, S6, S7 have a decision recorded | reports |
| S4 (AGNC) and S9 (remote) are marked deferred to phases 7 and 6 | README status table |

- [ ] **Step 2: Apply the spike decisions to the contracts**

- If S6 is NO-GO, change §1 of `00-contracts.md` to "UI kit: shadcn/ui".
- If S3 needs the hook bridge, add a line to `plan/phase-2-*.md`, Task "Live status", saying the hook ingest is required.
- If S7 found an official source, add its field path to §4 as `UsageSource = 'official' | 'estimate'`.

- [ ] **Step 3: Update the README status table, commit and merge**

```bash
git add plan
git commit -m "docs(plan): record phase 0 outcomes"
git checkout main && git merge --no-ff phase/0-foundations -m "merge: phase 0 foundations and spikes"
```
