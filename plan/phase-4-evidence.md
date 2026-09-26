# Phase 4 — M4 exit check evidence

Checked on **2026-09-26** (local, UTC+3) on branch `phase/4-worktrees-review-merge`. The phase is
the 21 task commits `ab42440`…`d5089fc`, the four fix commits `2537f60`, `f76d12e`, `644bc3f`,
`f9d2edb`, the Task 22 e2e commit `8adffc8`, and the Task 22 docs commit that adds this file.

Two kinds of evidence are used:
- **Fixture runs:** the unit suite, the Phase 1–3 Playwright suite against
  `apps/daemon/test/e2e-server.ts`, and the M4 Playwright run (`pnpm --filter @orc/web e2e:m4`),
  which seeds a temp repo, a bare remote, fake `claude` and fake `gh`.
- **Manual scratch-repo check:** the built daemon on a scratch repo with fake `claude` and fake
  `gh`, driven through the browser and the API. Steps, results and findings are in
  [`spikes/M4-manual.md`](spikes/M4-manual.md); screenshots in
  [`evidence/phase-4/`](evidence/phase-4/).

Nothing ran against a real repository, the real `~/.claude` or a real GitHub account. So plan
approval in the real TUI (manual checks b and c) is **not verified**.

| # | Criterion (`docs/05-roadmap.md` M4) | Verdict |
|---|---|---|
| 1 | Worktree discovery | ✅ verified (unit + manual j); not run on the real machine |
| 2 | Create from ticket, env copy, setup/run/archive scripts | ✅ verified (unit + e2e + manual a); setup output not seen by eye |
| 3 | Open in IDE, sync to main checkout | ◐ sync verified (unit + manual h); open-in verified by unit only |
| 4 | Archive when the PR merges | ✅ verified (unit + e2e + manual k) |
| 5 | Coexists with `/conductor` | ✅ verified (unit + manual j) with a hand-made worktree; no real `/conductor` worktree |
| 6 | Diff viewer and review summary card | ✅ verified (unit + e2e + manual g); summary card does not refresh after PR creation |
| 7 | Inline comments sent to the agent | ✅ verified (unit + e2e + manual g) |
| 8 | Per-turn checkpoints and rewind | ◐ checkpoints and rewind verified (unit + manual d, e); per-turn creation by unit only |
| 9 | Partial revert | ✅ verified (unit + manual f) |
| 10 | Commit/push/PR/checks/merge | ✅ verified (unit + e2e + manual k); checks only as `none` from fake `gh` |
| 11 | Backmerge action | ◐ unit only |
| 12 | GitHub connector: PR state and events → inbox | ◐ unit only; the poller ran against fake `gh` in manual k |
| 13 | Plan-approval step in launch | ◐ unit only; manual b and c not run |
| 14 | **Exit:** ticket → worktree → agent → review with inline comments → PR → merged → worktree archived, without leaving the app | ✅ verified (e2e:m4 + manual a, g, k) with fake `claude` and fake `gh` |
| 15 | Every write audited | ✅ verified (coverage guard + e2e soft asserts + manual l) |
| 16 | Suite green | ✅ lint, typecheck, 1509 unit tests, fixtures clean, 9/9 Playwright, 1/1 M4 Playwright |

---

## 1 — Discovery

- Commits: `3c214ce` (porcelain parsing), `cd9ea74` (sources), `2404005` (persisted views).
- Unit: `packages/core/src/git/worktree-porcelain.test.ts`,
  `apps/daemon/src/services/worktree/discover.test.ts`,
  `apps/daemon/src/services/worktree/worktree-read.test.ts` (config repos, session cwds,
  `githubRepoPaths` only from `.claude.json`, `.worktrees`, siblings, `claude-*` scratchpads).
- Manual j: a `git worktree add` sibling shows as origin `sibling`, `createdByApp: false`,
  `external` on `/worktrees` ([`worktrees.png`](evidence/phase-4/worktrees.png)).
- **Not verified:** discovery on the real machine. The plan asked for a read-only `/worktrees`
  screenshot on real data; none was taken.

## 2 — Create from ticket, env copy, scripts

- Commits: `5b63480`, `577c665` (UI).
- Unit: `packages/core/src/git/branch.test.ts` (`<type>/<TICKET>-<slug>`, 30-char slug),
  `apps/daemon/src/services/worktree/worktree-write.test.ts`,
  `apps/web/src/features/worktrees/WorktreesPage.test.tsx`.
- E2E: `m4-ticket-to-merge.spec.ts` creates `feat/SAF-4242-e2e-flow` from the dialog.
- Manual a:
  ```
  branch preview      feat/SCR-1-scratch-check
  <wt>/.env           SCRATCH_ONLY=1        (copyGlobs [".env"])
  GET /api/pty        setup PTY running `echo setup-ran`
  ```
  The setup output itself was not seen by eye: the terminal dock showed only the agent tab.

## 3 — Open in IDE, sync to main

- Commits: `70e5b9d`, `0668b3b`, `577c665`.
- Unit: `apps/daemon/src/services/worktree/worktree-sync.test.ts`,
  `apps/daemon/src/http/routes/worktrees.test.ts`.
- Manual h:
  ```
  GET  /api/worktrees/sync-preview → files ["src/a.ts"], mainDirty []
  POST /api/worktrees/sync         → 200 { files: 1 }; main's src/a.ts has the agent edit
  POST /api/worktrees/sync (again) → 409 main_dirty
  ```
- **Not verified by eye:** `POST /api/worktrees/open` launching VS Code, Terminal or Finder.

## 4 — Archive when the PR merges

- Commits: `70e5b9d` (archive), `518bbcb` (auto-archive on `pr.changed`).
- Unit: `apps/daemon/src/services/worktree/auto-archive.test.ts` (merged → archived; dirty or
  external → `pr_event` inbox item instead).
- E2E: after **Merge**, `.worktrees/feat-SAF-4242-e2e-flow` is gone, `/api/worktrees?state=active`
  no longer lists the branch, and the `worktree.archive` audit row has actor `automation`.
- Manual k: the worktree directory was gone at the first check after the merge dialog closed; the
  branch is kept; the checkpoint refs are pruned.

## 5 — Coexists with `/conductor`

- Unit: `discover.test.ts` and `worktree-write.test.ts` (existing branch reused, duplicate worktree
  refused), `worktree-sync.test.ts` (`external_worktree` without `confirmExternal`).
- Manual j: archive of the hand-made worktree without `confirmExternal` → `409 external_worktree`;
  the worktree stays.
- **Not verified:** a worktree created by a real `/conductor` run.

## 6 — Diff viewer and review summary card

- Commits: `c4c6e46`, `2c478df`, `f1f7c82`, `d5089fc`.
- Unit: `packages/core/src/git/diff-parse.test.ts`, `apps/daemon/src/services/diff/diff.test.ts`,
  `apps/daemon/src/services/review/review.test.ts`,
  `apps/web/src/features/review/ReviewPage.test.tsx`, `aside.test.tsx`.
- E2E: the `Changed files` tree lists `src/a.ts`, the `Viewed src/a.ts` checkbox is checked.
- Screenshot: [`review-aside.png`](evidence/phase-4/review-aside.png) — split diff, summary card
  `feat/SCR-1-scratch-check SCR-1 owned · 1 file · +1 −0 · Tests: not run · No recap yet · No PR yet`.
- **Finding:** the summary card still says `No PR yet` after the ship panel shows `#7`
  ([`ship-panel.png`](evidence/phase-4/ship-panel.png)).

## 7 — Inline comments sent to the agent

- Unit: `packages/core/src/git/review-prompt.test.ts`, `review.test.ts` (owned → `sendText`,
  otherwise `sent: false` with the text), `useReviewDraft.test.ts`.
- E2E: comment on the added line, **Send to agent**, `agent-input.log` contains `src/a.ts:2`.
- Manual g: the same on `src/a.ts:4`; audit rows `pty.input` and `review.send`.

## 8 — Per-turn checkpoints and rewind

- Commit: `1e7a47c`.
- Unit: `apps/daemon/src/services/checkpoint/checkpoint.test.ts` (HEAD, index and stash untouched),
  `turn-hook.test.ts` (checkpoint on `session.turnEnded` for owned sessions in a worktree).
- Manual d and e:
  ```
  before/after checkpoint  HEAD 2ca8345 add long.ts · stash empty · status " M src/a.ts"   (identical)
  ref                      refs/orchestrator/checkpoints/scr-session-1/1-manual-<epochMs>-<rand8>
  rewind to checkpoint 1   200; src/long.ts restored; kinds manual,manual → manual,manual,safety
  ```
- **Not verified end to end:** a `turn` checkpoint. The fake transcript never ends a turn, so the
  manual run only made `manual` checkpoints. The review page timeline hides `safety` checkpoints.

## 9 — Partial revert

- Unit: `packages/core/src/git/hunk-select.test.ts`, `diff.test.ts`.
- Manual f: `src/long.ts` with changes at lines 2 and 19 → 2 hunks; revert hunk 0 → line 2
  restored, line 19 kept.
- **Finding:** the revert safety ref `refs/orchestrator/reverts/<epochMs>` is not pruned when the
  worktree is archived.

## 10 — Commit, push, PR, checks, merge

- Commits: `e58dba5`, `799c097`, `d5089fc`.
- Unit: `apps/daemon/src/services/ship/ship.test.ts`, `apps/daemon/src/services/git/exec.test.ts`
  (`assertSafeGitArgs` blocks force pushes, ref-deletion pushes, hard resets, `git clean`, forced
  worktree removal, branch deletion, stash writes, `update-ref` outside `refs/orchestrator/`),
  `apps/daemon/src/http/routes/ship-plan.test.ts`.
- E2E and manual k: commit message carries the ticket; push reaches the bare remote; `gh pr create`
  uses the repo template and the ticket link; `gh pr merge 7 --squash`; no `--admin` and no
  `--force` in the fake `gh` call log.
- Screenshot: [`ship-panel.png`](evidence/phase-4/ship-panel.png).
- **Finding:** the PR body repeats `## Summary` (generated summary above a template that starts
  with its own `## Summary`).
- Checks were only ever `none`: the fake `gh` returns no status rollup in these runs.

## 11 — Backmerge

- Unit: `ship.test.ts` (`backmerge` spawns the backmerge template in a PTY). Not run manually.

## 12 — GitHub connector → inbox

- Commits: `f4aa371`, `518bbcb`.
- Unit: `apps/daemon/src/connectors/github/github.test.ts`,
  `apps/daemon/src/inbox/rules/pr-event.test.ts` (checks failed, changes requested, review
  requested, resolve on recovery), `apps/web/src/features/live-board/PrChip.test.tsx`.
- Manual k: the poller ran every 30 s against fake `gh` (`gh search prs --author=@me …`,
  `--review-requested=@me …`, `gh pr view 7 …`). No failing check or review was simulated, so no
  `pr_event` item was raised in the manual run.

## 13 — Plan-approval step in launch

- Commit: `3069e94`.
- Unit: `apps/daemon/src/services/review/plan-approval.test.ts`,
  `apps/daemon/src/inbox/rules/plan-approval.test.ts`, `apps/daemon/src/services/phase4-launch.test.ts`.
- **Not verified:** manual b and c need the real `claude` TUI in plan mode; they were not run.
  `PLAN_KEYS` in `apps/daemon/src/services/review/plan-keys.ts` is unchanged and unconfirmed.

## 14 — Exit: ticket → worktree → agent → review → PR → merged → archived

```
$ pnpm --filter @orc/web e2e:m4
  ✓  1 e2e/m4-ticket-to-merge.spec.ts:21:1 › ticket → worktree → agent → review with inline comment → PR → merged → worktree archived (16.8s)
  1 passed (18.4s)
```

The spec does every step in the browser: New worktree with **Launch Claude**, the fake agent edits
`src/a.ts`, review with an inline comment sent to the agent, Commit, Push, Create PR (`#101`),
Merge, then waits for the worktree directory to disappear. It soft-asserts the audit rows
`worktree.create`, `session.launch`, `review.send`, `git.commit`, `git.push`, `pr.create`,
`pr.merge`, `worktree.archive` (actor `automation`) and the absence of `--admin`/`--force` in the
fake `gh` calls. The manual run repeated the flow on a scratch repo (a, g, k).

## 15 — Every write audited

- Commits: `2537f60` (audit worktree launches and requests that fail before the service).
- `apps/daemon/test/audit.coverage.test.ts` enumerates every non-GET route; the Phase 4 routes are in
  `AUDITED_ROUTES` with `recordedBy: 'service'`, except `POST /api/worktrees/discover` (in
  `NON_ACTION_ROUTES`: read-only git). `apps/daemon/test/audit.phase4-failures.test.ts` covers
  requests that fail before the service records the action.
- Manual l and [`audit.png`](evidence/phase-4/audit.png): 18 rows for the run, including the
  refused archives and sync as `error` and the merge-driven archive as `automation`.

## 16 — Suite green

Branch `phase/4-worktrees-review-merge` at `8adffc8`, each gate under `timeout 900`:

```
$ pnpm run lint            → 0   Checked 546 files in 183ms. No fixes applied. Found 1 info.
$ pnpm run typecheck       → 0   packages/api-contract, apps/daemon, apps/web: Done
$ pnpm run test            → 0   Test Files 156 passed (156) · Tests 1509 passed (1509)
$ pnpm run check:fixtures  → 0   fixtures clean
$ pnpm --filter @orc/web e2e     → 0   9 passed (12.2s)
$ pnpm --filter @orc/web e2e:m4  → 0   1 passed (18.4s)
```

The lint info is biome asking for `biome migrate` on its own config. The web build warns about
chunks over 500 kB: `review._source._id-*.js` 1,073,570 bytes and `_id-*.js` 746,663 bytes.

## Deviations from the Phase 4 plan text

1. **Manual check tools.** The plan's Step 4 uses the real `claude` and `gh` on `~/scratch/orc-m4`
   and a private GitHub repo. The check ran on a scratch repo in a temp directory with fake
   `claude`, fake `gh` and a local bare remote, so b and c (plan approval) were not run and k used
   fake GitHub.
2. **Evidence location:** screenshots are in `plan/evidence/phase-4/`, next to Phase 3's.
3. **Launcher layout:** the plan's `services/launch/{plan-mode,prepare}.ts` shipped as
   `services/launch.ts`, `services/launch-plan-mode.ts` and `services/launch-prepare.ts`.
4. **Errors:** routes throw P1's `ServiceError` (`services/errors.ts`), mapped from `GitError` by
   `toHttpError` with `GIT_ERROR_STATUS` in `http/routes/git-guard.ts`; there is no `HttpError`.
5. **Inbox keys:** rules pass `{ kind, scope, facet }` to the engine; no `prKey`/`planKey` helpers.
6. **Audit:** Phase 4 rows in `AUDITED_ROUTES` carry `recordedBy: 'service'`; the middleware wraps
   the handler in `withAuditScope` and writes its own row only when the service did not.
7. **Core git barrel:** `packages/core/src/git/index.ts` re-exports `slugify` as `branchSlug` and
   `DEFAULT_TICKET_REGEX` as `DEFAULT_BRANCH_TICKET_REGEX`, because both names already exist in
   `derive/`.
8. **Client:** the Phase 4 methods live in `packages/api-contract/src/client-phase4.ts`
   (`createPhase4Methods`), composed into `createApiClient`.
9. **Web:** `PrChip` (`features/live-board/PrChip.tsx`) and `InboxItemActions`
   (`features/inbox/InboxItemActions.tsx`) were created new; confirmations use
   `features/git/GitDialog.tsx`, because the kit has no Dialog primitive.
10. **GitHub poller in tests:** `apps/daemon/test/helpers.ts` and `apps/daemon/test/e2e-server.ts`
    write `github: { enabled: false }`; `wirePhase4` starts the poller only when
    `config.github.enabled` is true.

## Findings raised by this check

1. PR body repeats `## Summary` (criterion 10).
2. Review summary card keeps `No PR yet` after PR creation (criterion 6).
3. `refs/orchestrator/reverts/<epochMs>` survives the worktree archive (criterion 9).
4. Safety checkpoints are hidden on the review page timeline (criterion 8).
5. `review._source._id-*.js` is 1.07 MB and `_id-*.js` 747 kB, both above Vite's 500 kB warning.
