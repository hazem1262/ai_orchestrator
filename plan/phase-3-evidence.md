# Phase 3 — M3 exit check evidence

Checked on **2026-09-24** (local, UTC+3) on branch `phase/3-session-detail-safety-audit`. The
phase is the 18 task commits `a902326`…`bb63300` plus the Task 19 commit that adds this file.

Two kinds of evidence are used:
- **Fixture runs:** the unit suite and Playwright against `apps/daemon/test/e2e-server.ts` (fixture
  homes, fake `claude`).
- **Real-data API check:** a second daemon from this branch, run read-only on the real `~/.claude`
  with a scratch `ORC_HOME` (archive off, `ORC_NOTIFY=off`, port 4398). It was stopped after the
  check, and its index and export were deleted. Nobody looked at the real session in a browser, so
  every "real data" line below is API output, not a screenshot.

Screenshots referenced here live in [`evidence/phase-3/`](evidence/phase-3/). They were taken by
earlier tasks against the fixture daemon.

| # | Criterion (`docs/05-roadmap.md` M3) | Verdict |
|---|---|---|
| 1 | Timeline with step inspector and timing stats | ✅ verified (unit + e2e + real data) |
| 2 | Deliverables row | ✅ verified (unit + real data); not seen by eye on a real session |
| 3 | Summary/Normal/Verbose modes | ✅ verified (unit + e2e) |
| 4 | Agents tree (failed/running expanded) + conductor rendering | ◐ partly — tree and chain verified; on the real session 55 of 84 agents map to no chain step and stay in the tree only |
| 5 | Usage chart, Files, Links, Raw tabs | ✅ verified (unit + e2e + real data for Links) |
| 6 | Export | ✅ verified (unit + e2e + real data: no token in a 177-file export) |
| 7 | Safety: badges, redaction, shared deny-list | ✅ verified (unit + real data) |
| 8 | Audit log (F24) | ✅ verified (unit + coverage guard + e2e) |
| 9 | Command palette (F8) | ✅ verified (unit + e2e) |
| 10 | **Exit:** a `/conductor` session can be understood without the terminal | ◐ verified by API and on fixtures; not looked at by eye on a real session |
| 11 | **Exit:** every app action appears in the audit log | ✅ verified (coverage guard + e2e) |
| 12 | Suite green | ✅ lint, typecheck, 1339 unit tests, fixtures clean, 9/9 Playwright |

---

## 1 — Timeline, step inspector, timing stats

- Unit: `packages/core/src/derive/step-stats.test.ts`,
  `apps/web/src/features/session-detail/timeline/timeline-pure.test.ts`,
  `apps/web/src/features/session-detail/timeline/TrajectoryTimeline.test.tsx`.
- E2E `session-detail-conductor.spec.ts:18`: `session-stats` contains `model`; clicking
  `Agent: Explore logs` opens the `Step inspector` with `"subagent_type": "Explore"`.
- Screenshots: [`timeline-s-subagents.png`](evidence/phase-3/timeline-s-subagents.png),
  [`timeline-turn-stats-s-basic.png`](evidence/phase-3/timeline-turn-stats-s-basic.png) — the
  session line `model 1m 11s · tools 25.0s · TTFT ≈5.0s · 0.4 tok/s · cache 95%` and one stats line
  per turn.
- Real data, the most recent `/conductor` session (`claude:a112d76e…`, 84 subagents):
  ```
  GET /stats → turns 167, wallMs 208431560, modelMs 58396945, toolMs 150034615,
               ttftMs 7507.5, cacheHitRate 0.979, per-turn rows 167, per-agent rows 84
  ```

## 2 — Deliverables row

- Unit: `packages/core/src/derive/deliverables.test.ts` (Edit/Write/MultiEdit/NotebookEdit and
  Codex `apply_patch`), `TrajectoryTimeline.test.tsx`.
- Screenshot: [`timeline-turn-stats-s-basic.png`](evidence/phase-3/timeline-turn-stats-s-basic.png)
  shows the `…/svc/a.ts` chip under turn 1.
- Real data: `GET /deliverables` → 70 turns with deliverables, 209 file entries.

## 3 — Summary / Normal / Verbose

- Unit: `timeline-pure.test.ts` (`buildTurnViews` per mode), `TrajectoryTimeline.test.tsx`.
- E2E test 1 switches to `Verbose` (the grouped `Agent ×1` button expands to
  `Agent: Explore logs`) and back to `Normal`.

## 4 — Agents tree and conductor chain

- Unit: `apps/web/src/features/session-detail/agents/agents-pure.test.ts` (default expansion of
  failed/running branches, tiered layout, `conductorStep`, `conductorChain`),
  `AgentsTree.test.tsx`.
- E2E test 1: `agent-node-ag1` shows `background`; `Open Leaf` navigates to
  `?tab=timeline&agent=ag3`, shows `Subagent: Leaf` and `done`, and `Back to main session` returns.
- Real data: `GET /agents` → 84 nodes, all `done`. `conductorChain` from
  `apps/web/src/features/session-detail/agents/conductor.ts`, run on those 84 nodes:
  ```
  repo-resolver pending 0 · branch done 3 · code done 15 · lint pending 0 · test done 7 ·
  build done 4 · visual-verify pending 0          mapped 29, unmapped 55 (types Explore, general-purpose)
  ```
  The 55 unmapped agents are plan reviews, Codex follow-ups and exploration. The plan's rule is
  "every subagent maps to a step, or stays visible in the tree view", and they stay in the tree.
  No `RULES` change was made: those agents are not conductor steps.
- **Not verified by eye:** no screenshot of the Agents tab exists, for fixtures or for real data.

## 5 — Usage, Files, Links, Raw

- Unit: `apps/web/src/features/session-detail/tabs/tabs.test.tsx`, `usage-option.test.ts`,
  `apps/daemon/test/session-detail.routes.test.ts`, `apps/daemon/src/services/session-detail/raw.test.ts`,
  `apps/daemon/test/links.test.ts`.
- E2E test 1: the usage chart renders a `canvas`; Files shows the empty state; the `Tickets` region
  contains `SUPRT-1557`; Raw shows `"sessionId":"s-subagents"` and, with `ag1` selected,
  `"agentId":"ag1"`.
- Screenshots: [`usage-s-subagents.png`](evidence/phase-3/usage-s-subagents.png),
  [`files-s-basic.png`](evidence/phase-3/files-s-basic.png),
  [`links-s-prlink.png`](evidence/phase-3/links-s-prlink.png),
  [`raw-s-subagents.png`](evidence/phase-3/raw-s-subagents.png).
- Real data, `GET /links` on `claude:a112d76e…`: 12 PRs across `wakecap-observation` and
  `frontend-2.0-om`, 14 tickets (`SAF-1781` first), plans matched by ticket from both
  `wakecap-plans` and `claude-plans`, 0 artifacts, no bridge session.

## 6 — Export

- Unit: `apps/daemon/test/export.test.ts` (redacted by default, subagents included, `409` for an
  unredacted export without `confirm`).
- E2E test 1 downloads `claude-s-subagents.zip`; test 2 then finds `session.export` in `/audit`.
- Real data, `GET /export` on `claude:a112d76e…`:
  ```
  200 application/zip, 33387373 bytes, 177 files
  (manifest, session, agents, deliverables, files, links, audit JSON; transcript.jsonl; 168 subagents/ entries)
  unzip -p <zip> transcript.jsonl | grep -cE 'ghp_|sk-ant-|xox[bp]-'                   → 0
  unzip -p <zip> | grep -cE 'ghp_[A-Za-z0-9]{20}|sk-ant-[A-Za-z0-9]{10}|xox[bp]-[0-9]' → 0
  markers in the whole zip: «redacted:secret» 1235, «redacted:jwt» 320,
                            «redacted:credentials» 17, «redacted:github» 2, «redacted:aws» 2
  GET /export?redact=false (no confirm)                                               → 409
  ```

## 7 — Safety: badges, redaction, shared deny-list

- Unit: `packages/core/src/derive/deny-list.test.ts`, `packages/core/src/derive/safety.test.ts`,
  `packages/core/src/redact/redact-deep.test.ts`, `apps/daemon/test/safety.test.ts`,
  `apps/daemon/test/redaction.routes.test.ts` (every transcript-bearing route, FTS snippets with
  partial tokens, WS events), `apps/web/src/features/safety/SecretsHygienePanel.test.tsx`,
  `apps/web/src/features/session-detail/header-actions.test.tsx`.
- Real data:
  ```
  GET /safety  → permissionMode bypassPermissions, badge bypass, touchedProd true,
                 3 prod touches (tools Bash, Skill)
  GET /api/safety/secrets → 24 findings across 20 files; ~/Wakecap/.mcp.json exists,
                 findings [(10, github), (10, json-secret-field)]
  GET /api/safety/secrets | grep -cE 'ghp_|sk-ant-|xox[bp]-|github_pat_'  → 0
  ```
- **Not verified by eye:** the PROD badge in the header of a real session, and the Settings →
  Secrets hygiene panel on real data. The panel screenshot taken during Task 17 shows real
  `~/Wakecap` file paths and is deliberately not stored in the repo.

## 8 — Audit log (F24)

- Unit: `apps/daemon/test/audit.service.test.ts` (append-only triggers, filters),
  `apps/daemon/test/audit.routes.test.ts`, `apps/daemon/src/pty/audited-pty.test.ts`,
  `apps/web/src/features/audit/AuditPage.test.tsx`.
- E2E test 2: after a resume and a PTY kill, `/audit?sessionPk=claude%3As-subagents` shows
  `session.resume`, `session.kill` and `session.export` rows.
- Screenshot: [`audit.png`](evidence/phase-3/audit.png).
- Real data: the export above recorded `[('session.export', 'ok')]` for that session in the
  scratch `ORC_HOME`.

## 9 — Command palette (F8)

- Unit: `apps/web/src/features/hotkeys/registry.test.ts`,
  `apps/web/src/features/palette/CommandPalette.test.tsx`, `palette-items.test.ts`.
- E2E test 2: `ControlOrMeta+k`, type `SUPRT-1557`, pick the session → `/sessions/claude/s-subagents`;
  `g` then `i` → `/inbox`.
- Screenshot: [`palette-open.png`](evidence/phase-3/palette-open.png) — navigation items with
  `G then I/W/H/A` hints and `N` for a new session. It was taken on the e2e daemon; the only
  paths in it are the macOS temp directory of the e2e `work` folder.

## 10 — Exit: a `/conductor` session is understandable without the terminal

On fixtures, e2e test 1 walks every tab of `s-subagents`. On real data, the API returns stats for
all 167 turns, deliverables for 70 of them, 84 agents with a conductor chain, 12 PRs, 14 tickets,
matched plans, the bypass badge and 3 prod touches. **Nobody has opened a real `/conductor`
session in the browser and read it**, so the plan's manual items (a)–(d) are verified by API only.

## 11 — Exit: every app action appears in the audit log

- `apps/daemon/test/audit.coverage.test.ts` enumerates every non-GET route registered on the app and
  fails unless each is in `AUDITED_ROUTES` or `NON_ACTION_ROUTES` (with a reason).
- `AUDITED_ROUTES` covers `session.resume`/`session.fork`, `session.launch`, `session.kill` (both
  `POST …/kill` and `DELETE /api/pty/:id`), `archive.restore`, `archive.sync`, `session.open`
  (`open-in`) and `session.export`; `withPtyInputAudit` records `pty.input`.
- `NON_ACTION_ROUTES` exempts local state: project PATCH, pin, label, saved views, inbox actions,
  notification prefs, the hooks ingest and `deny-check`.
- E2E test 2 (criterion 8).

## 12 — Suite green

Branch `phase/3-session-detail-safety-audit`, after the Task 19 e2e-server change:

```
$ pnpm run lint            → 0   Checked 427 files in 101ms. No fixes applied. Found 1 info.
$ pnpm run typecheck       → 0   apps/daemon typecheck: Done · apps/web typecheck: Done
$ pnpm run test            → 0   Test Files 117 passed (117) · Tests 1339 passed (1339)
$ pnpm run check:fixtures  → 0   fixtures clean
$ pnpm --filter @orc/web build && pnpm --filter @orc/web e2e → 0   9 passed (10.6s)
```

The 9 Playwright tests: `history.spec.ts` ×3, `live-inbox.spec.ts` ×4,
`session-detail-conductor.spec.ts` ×2.

The web build warns that `dist/assets/_id-*.js` is 746.64 kB (gzip 249.18 kB), above Vite's
500 kB chunk warning.

## Deviations from the Phase 3 plan text

1. **E2E server cwd.** Fixture `s-subagents` records cwd `/Users/test/Wakecap`, which does not exist,
   so the resume in e2e test 2 returned `422 cwd_missing`. `apps/daemon/test/e2e-server.ts` now
   rewrites the copied `s-subagents.jsonl` to the e2e `work` directory. The spec's assertions are
   unchanged.
2. **E2E spec, relative to the plan's Step 1 code:** the heading lookup is
   `getByRole('heading', { level: 1, name: … })`, and the view-mode radios use
   `.check({ force: true })` instead of `.click()`. Biome reordered one import and wrapped one line.
3. **Evidence location:** screenshots are in `plan/evidence/phase-3/`, next to Phase 2's
   `plan/evidence/`, not the plan's `plan/spikes/evidence/phase-3/`.
4. **Contracts, as built** (merged into `00-contracts.md`):
   - `ApiCallError` is a re-export alias of P1's `ApiRequestError` in `client-p3.ts`, not a class.
   - The P3 schemas reuse `UsageSchema` from `packages/api-contract/src/domain.ts`.
   - Error bodies go through `redactedApiError`; transcript JSON through `redactedJson`; WS through
     `toWireEvent`.
   - `safety` and `links` config blocks use `.prefault({})`.
   - `DaemonContext.audit` and `.denyList` are required, not optional.
   - The session-detail, links and export services are built inside their `register*Routes`
     functions (links and export lazily, on first request), not on `DaemonContext`.
   - `permissionBadge` lives in `derive/permission.ts` and prod detection in `derive/prod-detect.ts`.
   - Only `median` shipped (in `derive/step-stats.ts`); there is no `stats-math.ts` or `percentile`.

## Findings raised by this check

1. **The secrets scan reads real files under e2e.** `safety.secretScanPaths` expands `~` against the
   real home directory, not `ORC_USER_HOME`, so a daemon on fixture homes (e2e, tests without an
   explicit `home`) scans the real `~/Wakecap/.mcp.json` and `~/Wakecap/.claude/commands/*.md`.
   Nothing is written and no value is returned, but the fixture run is not isolated.
2. **Most real subagents are outside the conductor chain** — 55 of 84 on the session above
   (criterion 4). The tree shows them; the chain does not.
3. **Large web chunk** — `_id-*.js` 746.64 kB (criterion 12).
4. **`apps/daemon/src/services/sessions.test.ts:237`** is still timing-sensitive under parallel
   load. It passed in the run above.
