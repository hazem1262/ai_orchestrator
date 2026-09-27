# Phase 6 — M6 exit check evidence

Checked on **2026-09-27** (local, UTC+3) on branch `phase/6-linear-slack-remote`.
The phase is the S9 spike commit `66ca85c`, the 19 task commits `1b591dd`…`6d4a101` for Tasks
2–20, the fix `24575e0`, and the Task 22 docs commit that adds this file. Task 21 (optional Linear
OAuth with refresh tokens) was **skipped** by instruction.

Evidence is automated only:
- **Unit suite:** `pnpm run test`, which includes `apps/daemon/test/p6-daemon.test.ts`
  (`createPhase6` on a `p6Context()` with every override set, then `createApp`) and the
  `createDaemon` tests `p2-daemon.test.ts`, `p5-daemon.test.ts` and `server.test.ts`, which now
  pass `phase6: offlinePhase6()`.
- **Playwright:** `apps/web/e2e/mobile.spec.ts` was added in `82b9f30`. The Playwright suites were
  **not** re-run for this exit check.

Safety rules held for every run: no test touches the real Keychain, Linear, Slack, a push service,
`ioreg` or `tailscale`: every test daemon passes `phase6: offlinePhase6()`
(`apps/daemon/test/p6-connector-fakes.ts`), and `secret-store.test.ts` mocks `@napi-rs/keyring`
with an in-memory fake ("resolves @napi-rs/keyring to the in-memory fake, never the native module"). No `tailscale serve`, `tailscale funnel`, Slack, Linear or Keychain
command was run for this check.

**Nothing in this phase has been checked against a real tailnet, phone, passkey, push service,
Keychain, Linear workspace or Slack workspace.** Every row below that needs one says
**manual — not yet run**.

| # | Criterion (`docs/05-roadmap.md` M6) | Verdict |
|---|---|---|
| 1 | Linear connector acts as me: enriches streams, creates follow-ups, posts recaps and handoffs as comments | ◐ unit only (fake Linear API); manual — not yet run |
| 2 | Slack connector acts as me: posts recaps and daily updates, DM bridge | ◐ unit only (fake Slack API); manual — not yet run |
| 3 | Remote & Mobile: Tailscale PWA, Web Push, passkey step-up, away mode | ◐ unit + one mobile-layout e2e; manual — not yet run |
| 4 | **Exit:** a waiting session is answered from the phone (PWA **or** Slack DM thread) | ◐ unit only (`session-actions.test.ts`, `slack-bridge.test.ts`); manual — not yet run |
| 5 | **Exit:** the daily update is posted from the app | ◐ unit only (`share.test.ts`, `share.test.tsx`); manual — not yet run |
| 6 | Spike S9 recorded a decision | ◐ `plan/spikes/S9.md` records read-only checks and "go with the plan's defaults — unconfirmed"; live checks a–h manual — not yet run |
| 7 | Every automated check is green | ✅ lint, typecheck, 1885 unit tests in 232 files, fixtures clean (builds and Playwright not re-run here) |

---

## Commits

| Task | Commit | What |
|---|---|---|
| 1 | `66ca85c` | S9 read-only checks and pending manual steps |
| 2 | `1b591dd` | config, route schemas, client methods, bus events |
| 3 | `824244d` | tables, repositories, actor scope, test fakes |
| 4 | `182d9ef` | Keychain-backed `SecretStore` |
| 5 | `a7da9d1` | Linear connector |
| 6 | `cf34555` | Slack connector |
| 7 | `d0ae685` | connector status, token, OAuth app, callback, disconnect routes |
| 8 | `392315f` | Settings → Connectors |
| 9 | `2f4ef85` | `ShareService` and routes (redact → confirm → audit) |
| 10 | `664d039`, fix `24575e0` | Linear assigned, Slack mention and stream title pollers |
| 11 | `ccf7776` | Linear chip, share dialogs, follow-up tickets, daily update button |
| 12 | `2a375d5` | remote guard, device pairing, route policy, step-up store |
| 13 | `b541871` | reply and approve for owned sessions |
| 14 | `9fe5737` | WebAuthn registration and step-up |
| 15 | `450ff27` | VAPID web push channel and subscription routes |
| 16 | `038359d` | Slack DM bridge |
| 17 | `2a2c70b` | away mode, macOS idle detection, away routing |
| 18 | `91afd33` | PWA shell, service worker push, device token, pairing page |
| 19 | `82b9f30` | mobile layouts, reply composer, read-only diff, Settings → Remote |
| 20 | `6d4a101` | `createPhase6` wiring, guard, WS, audit route list |
| 21 | — | **skipped** by instruction (optional Linear OAuth with refresh tokens) |
| 22 | this commit | setup doc, evidence, contract merge, status |

## M6-1 Connectors connect as me

Automated:
- `apps/daemon/src/http/routes/connectors.test.ts` › "connects Slack with a pasted token that never
  reaches SQLite", "never echoes a pasted token, on success or in the status list", "audits a token
  paste once through the real middleware, with no token in the entry", "makes exactly the two OAuth
  callbacks public", "runs the OAuth flow once per state" (commit `d0ae685`).
- `apps/daemon/src/services/secrets/secret-store.test.ts` › "uses service "orchestrator" by default
  with the key as the account" — against a fake `AsyncEntry` (`182d9ef`).
- `apps/daemon/src/connectors/linear/linear.test.ts`, `apps/daemon/src/connectors/slack/slack.test.ts`
  (`a7da9d1`, `cf34555`), `apps/web/src/features/settings/ConnectorsPanel.test.tsx` (`392315f`).

| step | evidence |
|---|---|
| Linear personal API key pasted in Settings → Connectors | manual — not yet run |
| Slack User OAuth Token pasted (or OAuth flow completed) | manual — not yet run |
| No token in SQLite (`strings ~/.orchestrator/index.db ~/.orchestrator/index.db-wal \| grep -c -e 'xoxp-' -e 'lin_api_'` → `0`) | manual — not yet run (unit: "connects Slack with a pasted token that never reaches SQLite") |
| Tokens in the real macOS Keychain (`security find-generic-password -s orchestrator -a slack.token -w \| head -c 5` → `xoxp-`) | manual — not yet run. There is no `ORC_TEST_KEYCHAIN=1` real-Keychain test in the repo; the plan's constraint mentions one, but none was written |
| Audit: two `connector.connect` `ok` entries with no token in params | manual — not yet run (unit: "audits a token paste once … with no token in the entry") |

## M6-2 Linear comment from a session (F11)

Automated: `apps/daemon/src/http/routes/share.test.ts` › "previews a redacted Linear recap comment,
then posts the confirmed text", "uses the handoff markdown", "creates a follow-up ticket in the
session ticket team, assigned to me", "records a preview of at most 300 chars in the audit entry,
never the full body" (`2f4ef85`); `apps/web/src/features/share/share.test.tsx` (`ccf7776`);
`apps/daemon/src/connectors/pollers.test.ts` › "fills missing stream titles from Linear" (`664d039`)
and `apps/daemon/src/db/repos/streams.test.ts` (`24575e0`).

| step | evidence |
|---|---|
| Session detail → "Recap → Linear" → Preview | manual — not yet run |
| Confirm and post; comment authored by me | manual — not yet run |
| Audit `linear.comment` with the identifier and a 300-char preview | manual — not yet run |
| Follow-up ticket assigned to me with the "Follow-up from Orchestrator session" footer | manual — not yet run |

## M6-3 Daily update posted from the app (exit criterion)

Automated: `share.test.ts` › "posts the daily update to the configured channel", "audits a confirmed
post exactly once through the real middleware, and a 409 not at all"; `share.test.tsx`
(`DailyUpdateButton`).

| step | evidence |
|---|---|
| Inbox → "Post daily update" → Preview → Confirm; message in the channel, posted as me | manual — not yet run |
| Audit `slack.post` with the channel id | manual — not yet run |

## M6-4 Answer a waiting owned session from the phone (exit criterion)

Automated:
- `apps/daemon/src/http/remote-guard.test.ts` (10 tests: identity, host, origin, device token,
  pairing, step-up, revoke, `/bootstrap.js`, route classes), `apps/daemon/src/http/ws-remote.test.ts`,
  `apps/daemon/src/remote/remote.test.ts` (`2a375d5`).
- `apps/daemon/src/services/remote/session-actions.test.ts` › "requires step-up for remote replies
  and audits them as remote" (`b541871`).
- `apps/daemon/src/remote/webauthn.test.ts` (`9fe5737`), `apps/daemon/src/notify/webpush.test.ts`
  (`450ff27`), `apps/web/src/pwa/pwa.test.ts`, `apps/web/src/features/remote/PairPage.test.tsx`
  (`91afd33`), `apps/web/src/features/mobile/mobile.test.tsx`,
  `apps/web/src/features/remote/RemotePanel.test.tsx`, `apps/web/e2e/mobile.spec.ts` (`82b9f30`).
- `apps/daemon/test/p6-daemon.test.ts` (`6d4a101`).

| step | evidence |
|---|---|
| `tailscale serve --bg http://127.0.0.1:4317`, `tailscale serve status` | manual — not yet run |
| Settings → Remote → save origin + login, create pairing code | manual — not yet run |
| Phone pairs at `/pair`, creates a passkey, allows notifications | manual — not yet run |
| Home-screen install (iOS) | manual — not yet run |
| Session asks a question; Live Board shows `waiting` | manual — not yet run |
| Push notification arrives on the phone | manual — not yet run |
| Tapping it opens the session on the phone | manual — not yet run |
| Reply → Face ID / Touch ID step-up → sent | manual — not yet run |
| Answer appears in the desktop terminal; session continues | manual — not yet run |
| Audit `pty.input` with `actor: remote`, `actorDetail: "<device> (<login>)"` | manual — not yet run (unit: `session-actions.test.ts`) |

## M6-5 Answer from the Slack DM thread (exit criterion)

Automated: `apps/daemon/src/services/remote/slack-bridge.test.ts` › "posts one redacted DM thread per
item with a tailnet link", "sends my thread replies to the owned session exactly once", "approves on
✅ once and resolves the thread", "snoozes on 💤 and on !snooze, and marks done on !done", "refuses
replies for sessions the app does not own" (`038359d`); `apps/daemon/src/remote/away.test.ts`
(`2a2c70b`).

| step | evidence |
|---|---|
| Settings → Remote → "Away now"; `away.set` audit entry | manual — not yet run |
| A waiting item arrives as a DM to myself | manual — not yet run |
| Reply "yes, continue"; the session receives it within 15 s | manual — not yet run |
| React ✅ on a plan-approval item | manual — not yet run |
| Reply `!snooze 30` on another item | manual — not yet run |
| Audit `pty.input` (`actor: remote`, `actorDetail: slack_dm`) and `remote.approve` | manual — not yet run |

## M6-6 Security checks

| check | expected | automated | manual |
|---|---|---|---|
| `/bootstrap.js` from the phone | `window.__ORC_TOKEN__ = null;` | `remote-guard.test.ts` › "never hands the install token to remote requests" | manual — not yet run |
| Install token used from the phone | `401 unauthorized` | `remote-guard.test.ts` › "checks identity, host, origin and the device token" | manual — not yet run |
| State-changing call without step-up | `401 step_up_required` | `remote-guard.test.ts` › "requires step-up for state-changing remote routes" | manual — not yet run |
| `POST /api/sessions/launch` from the phone | `403 remote_forbidden` | `remote-guard.test.ts` › "classifies routes" | manual — not yet run |
| Funnel on → any remote request | `403 funnel_detected` | `remote.test.ts` › "reads AllowFunnel from serve status" (the `AllowFunnel` key is an assumption until S9 check h) | manual — not yet run |
| Deny-listed Slack reply (`terraform apply`) | `:x: Not done (denied)`, nothing sent | `session-actions.test.ts` › "blocks deny-listed remote input and audits the denial"; `slack-bridge.test.ts` › "reports refusals in the thread" | manual — not yet run |
| Reply to an **observed** session | `403 not_owned` | `session-actions.test.ts` › "refuses sessions the app does not own" | manual — not yet run |
| Revoke the device in Settings → Remote | `401` on the next request | `remote-guard.test.ts` › "revokes devices from the Mac" | manual — not yet run |
| Wrong Tailscale identity | `403 remote_identity_mismatch` | `remote-guard.test.ts` › "checks identity, host, origin and the device token" | manual — not yet run |
| **Spoofed `Tailscale-User-Login` is stripped by `tailscale serve`** (S9 check c) | the real login, not the spoofed one | cannot be unit-tested | manual — not yet run. **S9 marks this NO-GO for Tasks 12–19 if it fails**: the remote guard trusts this header as the identity gate, and the tailnet is shared (161 devices) |

## Spike S9 — live checks still open

All from [`spikes/S9.md`](spikes/S9.md) → *Manual steps*. Each is **manual — not yet run**:

| # | Check | Binds |
|---|---|---|
| a | Origin reachable inside the tailnet only (phone with Tailscale on / off on cellular) | Task 12 |
| b | Headers `tailscale serve` sends (`host`, `x-forwarded-*`, `tailscale-user-login`, socket address) | `isRemoteRequest`, `remoteGuard` |
| c | Spoofed `Tailscale-User-Login` stripped | NO-GO for Tasks 12–19 if it fails |
| d1 / d2 | Web Push on Android / iOS (installed PWA) | `WebPushChannel` |
| e1 / e2 | Passkey registration and assertion with rpID = MagicDNS host (phone, desktop) | NO-GO for remote writes if it fails |
| f | Reply path from the phone | Task 13 |
| g1 | Slack accepts the `http://127.0.0.1` redirect URL | `connectors.slack.redirectUri` default |
| g2 / g3 / g4 | Self-DM notifies the phone; `app_id` on posted vs typed messages; Slackbot reminder nudge | `nudgeViaReminder` default, bridge reply filter |
| h | `AllowFunnel` key in `tailscale serve status --json` | `detectFunnel()` |

## Suite green

Branch at `6d4a101`, each gate under `timeout`, `ANTHROPIC_API_KEY` unset for the test run:

```
$ pnpm run lint            → 0   Checked 789 files. No fixes applied. Found 1 info.
$ pnpm run typecheck       → 0   packages/api-contract, apps/daemon, apps/web: Done
$ pnpm run test            → 0   Test Files 232 passed (232) · Tests 1885 passed (1885)
$ pnpm run check:fixtures  → 0   fixtures clean
```

Not re-run for this check: `pnpm --filter @orc/web build`, `pnpm --filter @orc/daemon build`,
`pnpm --filter @orc/web e2e`, `pnpm --filter @orc/web e2e:m4`. Test count over time: 1714 at the
Phase 5 exit → 1885 at Phase 6.

## Deviations from the Phase 6 plan text

1. **Task 20 registration.** `createPhase6(ctx, o)` (`apps/daemon/src/phase6.ts`) builds the services,
   sets them on `ctx` and returns `{ …, guardDeps, start(), stop() }`. It has **no `register` hook**.
   The Phase 6 routes are registered once, in `registerAllRoutes` (`http/app.ts`), and read their
   services per request (`503 unavailable` while unset), so nothing is registered twice.
   `AppOptions` gains `remote?: RemoteGuardDeps | null` and `phase6?: { guardDeps } | null` (only
   the guard deps are read). The remote, WebAuthn and push routes read `ctx.remoteAccess`
   (`{ devices, pairing, stepUp, funnel, webauthn, vapid, webpush }`). The Linear and Slack share
   posts stay in `AUDITED_ROUTES` with `recordedBy: 'service'`, not in `NON_ACTION_ROUTES`.
2. **Task 12 public paths.** `PUBLIC_API_PATHS` skips the token check for `GET` only. The remote
   policy table `REMOTE_RULES` covers every remote route class (`public`, `device`, `stepup`,
   `deny`), not only the step-up list. `remote.allowedLogin` is trimmed, and a blank value disables
   remote access (`403 remote_disabled`).
3. **Task 12 WS origin.** A remote WS upgrade goes through `evaluateRemote` (`http/ws-remote.ts`),
   which checks the Origin against `remote.origin`; the local WS allow-list is unchanged.
4. **Task 15 push payload.** `notify/format.ts` redacts the body first, then truncates it, so a
   secret cut in half by the limit cannot slip past `redact()`. A failed delivery logs only the
   push service's HTTP status, never the endpoint or payload.
5. **Task 13 inbox keys.** `inboxSessionPk` reads the session from the payload, then from the
   composed dedupe key `${kind}:session:${encodeURIComponent(pk)}[:${facet}]`, then from the plain
   `<kind>:<pk>` form, then from `sessionId`.
6. **Task 19 mobile e2e.** `mobile.spec.ts` makes an owned session by resuming the seeded
   `e2e-resume` transcript in an app PTY, instead of launching a new one.
7. **Stream titles.** Fix `24575e0`: a stream rebuild that derives no title keeps the title the
   Linear enricher set.
8. **Error codes** beyond the plan's list: `step_up_failed` (WebAuthn assertion rejected),
   `remote_only` (a device-only route called locally), `unavailable` (service not wired). `denied`
   is returned as `403 denied`.
9. **`push/test`** answers `{ sent: number }`.
10. **Pollers.** `createLinearAssignedPoller({ ctx, linear, now? })` and
    `createSlackMentionPoller({ ctx, slack, now? })` return `{ tick, start, stop }` and are started
    by `createPhase6().start()`. `LinearIssue` is defined in `@orc/api-contract`
    (`routes/connectors.ts`) and re-exported as a type from `connectors/linear/linear.ts`.
11. **Linear OAuth.** Task 21 skipped: there is no Linear OAuth provider, so
    `GET /api/connectors/linear/authorize` answers `404 not_found`; Linear connects by personal API
    key only. The token regex still accepts `lin_oauth_…`.
12. **Real-Keychain test.** No `ORC_TEST_KEYCHAIN=1` test was written; the real Keychain has never
    been exercised.
13. **Dependencies.** Installed: `@simplewebauthn/server` 14.0.3 (range `^14.0.2`), `web-push`
    3.6.7, `@simplewebauthn/browser` 14.0.0, `vite-plugin-pwa` 1.3.0, `workbox-*` 7.4.1,
    `@linear/sdk` 95.2.0 (96.0.0 exists; not adopted).

## Open follow-ups

- `apps/daemon/src/services/sessions.test.ts:237` fails now and then under parallel load (carried from Phase 5).
- `apps/web/src/features/settings/settings.test.tsx` fails now and then under parallel load (carried from Phase 5).
- `apps/web/src/features/worktrees/WorktreesPage.test.tsx` › "archives an external worktree only after both confirmations" is flaky.
- `apps/web/e2e/live-inbox.spec.ts:37` sees an inbox item leaked from `history.spec.ts` (shared e2e daemon state).
- Settings panels other than Remote overflow the viewport at phone width.
- The service-worker build warns that `inlineDynamicImports` is deprecated.
- Every manual check above, the S9 live checks a–h, the real Keychain, and real Linear and Slack connections.

All four runs of this exit check passed on the first try, so none of the flaky tests showed up.
