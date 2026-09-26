# M4 manual check — scratch repo

Run on **2026-09-26** (local, UTC+3) against the daemon built from `phase/4-worktrees-review-merge`
at `8adffc8` (`apps/daemon/dist/main.js`, web served from `apps/web/dist`).

## Setup

Everything ran in a throwaway directory `<scratch>` inside the agent's scratchpad under
`/private/tmp/claude-501/…/scratchpad/…/m4`. No real home, repository or GitHub account was touched.

| Piece | Value |
|---|---|
| Repo | `<scratch>/repo`, `git init -b main`, commits `init` (`src/a.ts`, `.gitignore` with `.worktrees/` and `.env`, `.github/pull_request_template.md`) and `add long.ts` (20 lines) |
| Remote | `<scratch>/remote.git`, a local bare repo set as `origin` |
| Ignored file | `<scratch>/repo/.env` with `SCRATCH_ONLY=1` |
| Homes | `ORC_HOME`, `CLAUDE_HOME`, `CODEX_HOME`, `HOME` and `ORC_USER_HOME` all under `<scratch>` |
| Git identity | `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, author `Scratch <scratch@example.com>` |
| `claude` | `apps/web/e2e/support/bin/claude` (fake; `FAKE_CLAUDE_SESSION_ID=scr-session-1`, `E2E_DIR=<scratch>`) |
| `gh` | `apps/daemon/test/bin/gh` (fake; `FAKE_GH_DIR=<scratch>/gh`, repo `example-org/orc-m4-scratch`, first PR `#7`) |
| Daemon | `timeout 1200 node apps/daemon/dist/main.js`, `ORC_PORT=4428`, `ORC_NOTIFY=off` |
| Config | project `scr`, `ticketRegex` `\bSCR-\d+\b`, repo with `setup: "echo setup-ran"` and `copyGlobs: [".env"]`; `github.enabled: true` (`pollSeconds: 30`); `worktrees.scratchpadRoots: []`; `safety.secretScanPaths: []`; `links.planRoots: []`; `archive.enabled: false` |
| Driver | a Playwright script (Chromium, 1440×900) plus direct API calls with the `x-orc-token` header |

The daemon and the driver were stopped at the end; `pgrep -f apps/daemon/dist/main.js` and
`pgrep -f e2e/support/bin/claude` return nothing.

## Results

| # | Check | How | Result |
|---|---|---|---|
| a | Worktree from ticket `SCR-1`, `.env` copied, setup output visible | `/worktrees` → New worktree (UI) | ✅ branch preview `feat/SCR-1-scratch-check`; `<wt>/.env` holds `SCRATCH_ONLY=1`; `GET /api/pty` lists the `echo setup-ran` PTY. ◐ The terminal dock showed only the agent tab, so the setup output was not seen by eye. |
| b | Plan approval: plan in the inbox, **Approve** starts implementation | — | ⏭ not run. The fake `claude` has no plan mode and the real TUI was not used. Covered only by Task 16 tests (`plan-approval.test.ts`, `phase4-launch.test.ts`). |
| c | **Reject** with feedback; Claude revises | — | ⏭ not run, same reason as b. `PLAN_KEYS` was not changed. |
| d | A checkpoint leaves `git log -1`, `git stash list` and the index alone | `POST /api/checkpoints` | ✅ `2ca8345 add long.ts`, empty stash and ` M src/a.ts` before and after; ref `refs/orchestrator/checkpoints/scr-session-1/1-manual-<epochMs>-<rand8>`. ◐ Only `manual` checkpoints: the fake transcript never ends a turn, so no `turn` checkpoint was created. |
| e | Rewind restores files; a safety checkpoint appears | `POST /api/checkpoints/:id/rewind` | ✅ `200`; `src/long.ts` back to the first checkpoint, the agent's `src/a.ts` edit kept; kinds `manual,manual` → `manual,manual,safety`. The review page timeline filters `safety` out (`CheckpointTimeline.tsx:28`), so the new one shows in the API only. |
| f | Revert one hunk; the other stays | `POST /api/diff/revert` `hunkIndex: 0` | ✅ `src/long.ts` had 2 hunks (lines 2 and 19); after the revert the line-2 change is gone and the line-19 change stays. |
| g | Inline comment → Send to agent → agent receives it | Review page (UI) | ✅ comment on `src/a.ts:4`; after **Send** the fake agent's `agent-input.log` contains `src/a.ts:4`. Audit: `pty.input` and `review.send`. |
| h | Sync to main copies changed files; a local edit in main refuses the sync | `GET /api/worktrees/sync-preview`, `POST /api/worktrees/sync` | ✅ preview `files: ["src/a.ts"]`, `mainDirty: []`; first sync `200`, `files: 1`, main's `src/a.ts` has the edit; second sync with main now dirty → `409 main_dirty`. Main was restored with `git restore -- src/a.ts` afterwards. |
| i | Archive with uncommitted changes is refused | `POST /api/worktrees/archive` | ✅ `409 dirty_worktree`; the worktree stays. |
| j | Hand-made worktree shows as external; archive needs the extra confirmation | `git worktree add -b chore/ext-manual <scratch>/ext-manual`, `POST /api/worktrees/discover`, archive without `confirmExternal` | ✅ origin `sibling`, `createdByApp: false`, `/worktrees` shows `external`; archive → `409 external_worktree`; the worktree stays. |
| k | Commit → Push → PR (template) → Merge → worktree archived | Review page ship panel (UI) | ✅ message `feat: SCR-1 scratch check`; `feat/SCR-1-scratch-check` on the bare remote; `gh pr create … --base main --head feat/SCR-1-scratch-check`; PR `example-org/orc-m4-scratch#7`; body holds the template's `## Test plan` and `Ticket: [SCR-1](https://linear.app/wakecap/issue/SCR-1)`; `gh pr merge 7 --squash`; worktree directory gone at the first check after the merge dialog closed; branch kept; no `--admin` or `--force` in `calls.jsonl`. |
| l | Every action appears in `/audit` | `GET /api/audit`, `/audit` page | ✅ `worktree.create`, `session.launch`, `checkpoint.create` ×3, `git.revert`, `checkpoint.rewind`, `worktree.archive` (error, dirty), `worktree.sync` (ok, then error), `worktree.archive` (error, external), `pty.input`, `review.send`, `git.commit`, `git.push`, `pr.create`, `pr.merge`, `worktree.archive` (actor `automation`, ok). |

## Findings

1. **PR body repeats `## Summary`.** The body was `## Summary\n\nscratch check\n\n## Summary\n\n## Test plan\n\n---\nTicket: …`:
   the generated summary is placed above the repo template, which starts with its own `## Summary`.
2. **The summary card keeps saying "No PR yet"** after the ship panel shows `#7 · open · checks none`
   ([`ship-panel.png`](../evidence/phase-4/ship-panel.png)).
3. **The revert safety ref outlives the worktree.** After the auto-archive the checkpoint refs are
   pruned, but `refs/orchestrator/reverts/<epochMs>` is still in the repo.
4. **Safety checkpoints are hidden** on the review page timeline (filtered in `CheckpointTimeline.tsx`).
   The API returns them.

## Screenshots

In [`plan/evidence/phase-4/`](../evidence/phase-4/). The only paths in them are the scratch
directory under `/private/tmp/claude-501/…`, whose name encodes the repo location; they show no
home directory contents, token or secret.

| File | Shows |
|---|---|
| [`worktrees.png`](../evidence/phase-4/worktrees.png) | `/worktrees` with `chore/ext-manual` (`external`), `main` (`main checkout`) and `feat/SCR-1-scratch-check` (`app`, `dirty`, ticket `SCR-1`, 1 session); the agent's terminal tab in the dock |
| [`review-aside.png`](../evidence/phase-4/review-aside.png) | `/review/claude/scr-session-1`: split diff with the inline comment, the aside with the summary card (`owned`), checkpoints, ship form (template in the PR body) and `Comments (1)` |
| [`ship-panel.png`](../evidence/phase-4/ship-panel.png) | the ship panel after PR creation: `#7 · open · checks none`, merge method `squash`, **Merge** |
| [`audit.png`](../evidence/phase-4/audit.png) | `/audit` with every Phase 4 entry of the run, newest first, including the `automation` archive |
