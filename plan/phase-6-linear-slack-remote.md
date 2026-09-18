# Phase 6 — Linear, Slack & Remote/Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Deliver milestone M6. Linear and Slack connectors act **as me** with tokens kept in the macOS Keychain. The Slack DM bridge lets me answer owned sessions from a Slack thread. The app is reachable from my phone only through Tailscale, as an installable PWA with Web Push, per-device pairing, passkey step-up for write actions, and away mode.

**Architecture:**
- **Connectors.** Each connector wraps a narrow adapter (`LinearApi`, `SlackApi`) around the vendor SDK. Tests inject fake adapters. Secrets live only in the Keychain (`SecretStore`, service `"orchestrator"`). SQLite stores only non-secret metadata (`connector_tokens_meta`).
- **Posting.** Everything posted outward goes through a `ShareService`. It composes the text, redacts it, asks for confirmation (`409 confirmation_required` with a preview) and records an audit entry.
- **Remote access.** A `remoteGuard` middleware runs before the P1 token check. It classifies each request as local or remote. `tailscale serve` proxies from `127.0.0.1`, so the guard uses the Tailscale and `X-Forwarded-*` headers and the Host, not the socket address. For remote requests it enforces the Tailscale identity, a per-device token, a route policy (deny by default) and passkey step-up for state-changing actions.
- **Notifications.** Web Push and the Slack DM thread are `NotifyChannelImpl`s. Away mode picks which channels receive notifications.

**Tech Stack:** `@linear/sdk@^95.1.0`, `@slack/web-api@^8.1.1`, `@napi-rs/keyring@^2.1.0` (`AsyncEntry`), `web-push@^3.6.7`, `@simplewebauthn/server@^14.0.2` + `@simplewebauthn/browser@^14.0.0`, `vite-plugin-pwa@^1.3.0` (`injectManifest`) + `workbox-precaching@^7.4.1`, Hono, Drizzle, Vitest 5, Playwright. Versions were checked with `npm view` on 2026-09-17.

**Spec:**
- `docs/02-features.md`: F11 (Linear, Slack), F15 (notifications), F16 (handoff to Linear), F22 (Remote & Mobile), F24
- `docs/03-architecture-and-stack.md`: §4 session control, §9 remote access, §12 connectors, Security & privacy
- `docs/05-roadmap.md`: M6, spike S9, risk "Remote exposure of a local shell"
- `docs/README.md`: decisions "Slack/Linear act as me" and "Remote = Tailscale only, passkey for actions"
- `plan/00-contracts.md`: §3, §5, §6, §7, §8, §11, §12

## Global Constraints
- Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vitest `^5.0.1`, Biome `^2.5.14` (`noNonNullAssertion` and `noExplicitAny` are errors).
- **The daemon binds to `127.0.0.1` only.** Remote access goes only through `tailscale serve` inside the tailnet. **Never `tailscale funnel`.** The daemon blocks every remote request while a Funnel is detected.
- **Secrets never touch SQLite, logs, audit params or API responses.** Linear and Slack tokens, the OAuth client secrets and the refresh tokens live only in the Keychain under service `"orchestrator"`. Device tokens are stored only as SHA-256 hashes.
- **Slack and Linear act as the user.** They use a Slack user token (`xoxp-`) and a Linear personal API key or user OAuth token. No bot identities.
- **Redaction:** every string sent to Slack, Linear or Web Push passes through `redact()` from `@orc/core`. Connectors call `redact()` again on the way out (defence in depth).
- **Every outward post or write** (Linear comment or issue, Slack post, PTY input, approve, pair or revoke, connect or disconnect, passkey registration) records an `audit_log` entry. Human-initiated posts need `{"confirm": true}`; without it the route returns `409 confirmation_required` with `details.summary`, which holds the redacted preview.
- **Input goes only to owned sessions** (`live.ownership === 'owned'` with a `ptyId`). Otherwise the route returns `403 not_owned`. Input from a remote actor (PWA or Slack) is also checked against the deny-list (`ctx.denyList.check`). A match returns `403 denied` and is audited with result `denied`.
- **Remote writes need passkey step-up.** This covers send input, approve, stop/kill and merge. A step-up lasts `remote.stepUpTtlSec` (default 300 s). Any remote write that is not on the allow-list is refused (`403 remote_forbidden`).
- `GET /bootstrap.js` never returns the install token to a remote request. Remote devices use per-device tokens obtained by pairing.
- The PWA precaches only static build assets. It never caches API responses or transcript text.
- Tests never touch the real Keychain, Slack, Linear or push services. Real-Keychain tests run only with `ORC_TEST_KEYCHAIN=1`.
- Commits use Conventional Commits with a scope. Run `pnpm lint && pnpm typecheck && pnpm test` before every commit. Work on branch `phase/6-linear-slack-remote`.

---

## Operator setup (referenced by tasks 1, 8, 12, 22)

### A. Linear: personal API key (the default path)
1. In Linear, open **Settings → Security & access → Personal API keys → New API key**.
2. Name the key `orchestrator`. Give it Read + Write access (or "Full access") for the teams you work in.
3. Copy the `lin_api_…` key. In Orchestrator, open **Settings → Connectors → Linear**, paste the key and click **Connect**. The key goes into the Keychain as `orchestrator / linear.token`.

The optional OAuth path is Task 21.

### B. Slack app (one-time; the app acts as you through a user token)
1. Go to <https://api.slack.com/apps>, choose **Create New App → From an app manifest**, and pick your workspace.
2. Paste this manifest. Replace `<machine>.<tailnet>` with your MagicDNS name, or delete that line if you won't use OAuth over Tailscale.
   ```yaml
   display_information:
     name: Orchestrator (personal)
     description: Personal agent orchestrator. Posts and reads as me.
   oauth_config:
     redirect_urls:
       - http://127.0.0.1:4317/api/connectors/slack/callback
       - https://<machine>.<tailnet>.ts.net/api/connectors/slack/callback
     scopes:
       user:
         - chat:write
         - im:write
         - im:history
         - channels:history
         - groups:history
         - search:read
         - users:read
         - reminders:write
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```
   `reminders:write` is only used if spike S9 shows that DMs to yourself don't trigger phone notifications (`connectors.slack.nudgeViaReminder`).
3. **Redirect URL caveat.** Slack's docs say *"The `redirect_uri` must use HTTPS."* If Slack rejects the `http://127.0.0.1` URL (spike S9 check g), delete it. Then either use the `https://…ts.net` URL (set `connectors.slack.redirectUri` to it) or use the token-paste path in step 5.
4. **OAuth path:** open **Basic Information** and copy the *Client ID* and *Client Secret*. Paste both into **Settings → Connectors → Slack → OAuth app**, then click **Connect with Slack**. The daemon exchanges the code with `oauth.v2.access` and stores `authed_user.access_token` (an `xoxp-` token) in the Keychain as `slack.token`.
5. **Paste path (no redirect needed):** open **OAuth & Permissions → Install to Workspace → Allow**, copy the **User OAuth Token** (`xoxp-…`), and paste it into **Settings → Connectors → Slack → Connect**.
6. Optional: for the daily update, copy the channel ID (right-click the channel → *View channel details* → the ID at the bottom, `C…`) into `connectors.slack.dailyChannel` in `$ORC_HOME/config.json`.

### C. Tailscale serve (remote access)
1. Install Tailscale on the Mac and the phone, and log both into the **same** tailnet user. That user's login email becomes `remote.allowedLogin`.
2. In the Tailscale admin console, open **DNS** and enable **MagicDNS** and **HTTPS Certificates** (a one-time step).
3. On the Mac:
   ```bash
   tailscale status                                   # note <machine>.<tailnet>.ts.net
   tailscale serve --bg http://127.0.0.1:4317         # HTTPS inside the tailnet only
   tailscale serve status                             # shows https://<machine>.<tailnet>.ts.net → http://127.0.0.1:4317
   ```
   To turn it off: `tailscale serve --https=443 off`, or `tailscale serve reset`. **Never run `tailscale funnel`.**
4. In `$ORC_HOME/config.json`:
   ```json
   { "remote": { "enabled": true, "origin": "https://<machine>.<tailnet>.ts.net", "allowedLogin": "<you>@<domain>" } }
   ```
5. **Pair the phone:**
   1. On the Mac, open **Settings → Remote → Create pairing code**.
   2. On the phone, open `https://<machine>.<tailnet>.ts.net/pair`, enter the code and a device name.
   3. Create the passkey when prompted, then allow notifications.
   4. On iOS 16.4+ you must first **Add to Home Screen** and open the installed app before push can be enabled.

---

## Contract additions

These are merged into `plan/00-contracts.md` in Task 22.

**§1 — dependencies**

| Where | Package | Version |
|---|---|---|
| daemon | `@types/web-push` (dev) | `^3.6.4` |
| web | `@simplewebauthn/browser` | `^14.0.0` |
| web | `workbox-precaching` | `^7.4.1` |
| web | `workbox-build` (dev, peer of vite-plugin-pwa) | `^7.4.1` |
| web | `workbox-window` (dev, peer of vite-plugin-pwa) | `^7.4.1` |

**§3 — `$ORC_HOME/vapid.json`**

The file looks like `{ publicKey, privateKey, createdAt }`, with mode 0600. Add these `OrcConfig` fields (in `packages/api-contract/src/config.ts`):
```ts
export const RemoteConfig = z.object({
  enabled: z.boolean().default(false),
  origin: z.string().nullable().default(null),            // e.g. "https://mac.tail1234.ts.net" (no trailing slash)
  allowedLogin: z.string().nullable().default(null),      // Tailscale-User-Login that may use the app remotely
  stepUpTtlSec: z.number().int().positive().default(300),
  pairingTtlSec: z.number().int().positive().default(300),
});
export const AwayConfig = z.object({
  auto: z.boolean().default(true),
  idleMinutes: z.number().int().positive().default(10),
  channels: z.array(z.enum(['webpush', 'slack_dm'])).default(['webpush', 'slack_dm']),
});
export const ConnectorsConfig = z.object({
  linear: z.object({
    enabled: z.boolean().default(true),
    defaultTeamKey: z.string().nullable().default(null),
    pollSeconds: z.number().int().min(30).default(120),
    redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/linear/callback'),
  }).prefault({}),
  slack: z.object({
    enabled: z.boolean().default(true),
    redirectUri: z.string().default('http://127.0.0.1:4317/api/connectors/slack/callback'),
    dailyChannel: z.string().nullable().default(null),
    pollSeconds: z.number().int().min(30).default(60),
    dmBridge: z.boolean().default(true),
    bridgePollSeconds: z.number().int().min(5).default(15),
    nudgeViaReminder: z.boolean().default(false),
  }).prefault({}),
});
// OrcConfig gains:
//   remote: RemoteConfig.prefault({}), away: AwayConfig.prefault({}), connectors: ConnectorsConfig.prefault({}),
```

**§4 — new audit action names**

`connector.connect`, `connector.configure`, `connector.disconnect`, `linear.issue.create`, `inbox.approve`, `remote.configure`, `remote.pairing_code`, `remote.pair`, `remote.revoke`, `webauthn.register`, `away.set`.

These existing names are now used by Phase 6: `linear.comment`, `slack.post`, `pty.input`, `remote.approve`.

**§5 — tables (Phase 6)**

| Table | Key | Notes |
|---|---|---|
| `connector_tokens_meta` | `connector` | Non-secret metadata only: auth kind, account, scopes, poller cursor, status. |
| `remote_devices` | `id` | **New.** Holds `token_hash` (sha256, unique) and `revoked_at`. |
| `webauthn_credentials` | `id` (credential id, base64url) | `device_id` → `remote_devices.id` |
| `push_subscriptions` | `id`, unique `endpoint` | `device_id` is nullable |
| `slack_threads` | `inbox_item_id` | `channel`, `root_ts`, `last_seen_ts`, `app_ts_json`, `reactions_done_json`, `state` |

**§6 — routes (Phase 6)**
```
P6  GET    /api/connectors                                  → ConnectorStatus[]
P6  POST   /api/connectors/:id/token        body { token }  → ConnectorStatus          (loopback only)
P6  POST   /api/connectors/:id/app          body { clientId, clientSecret } → { ok }   (loopback only)
P6  GET    /api/connectors/:id/authorize                    → { url }                  (loopback only)
P6  GET    /api/connectors/:id/callback?code&state          → text/html                (public: no token; one-time state)
P6  DELETE /api/connectors/:id              body { confirm } → { ok }                  (loopback only)
P6  GET    /api/linear/issues/:identifier                   → LinearIssue
P6  POST   /api/linear/issues/:identifier/comment  body LinearCommentBody → { ok } | 409 preview
P6  POST   /api/linear/follow-up                   body LinearFollowUpBody → LinearIssue | 409 preview
P6  POST   /api/slack/post                         body SlackPostBody → { ts } | 409 preview
P6  POST   /api/sessions/:source/:id/reply          body { text } → { ok }             (owned only; remote: step-up)
P6  POST   /api/inbox/:id/approve                   body { confirm } → InboxItem        (remote: step-up)
P6  GET    /api/remote/status                               → RemoteStatus
P6  POST   /api/remote/config                  body { enabled, origin, allowedLogin } → RemoteStatus (loopback only; uses ctx.updateConfig)
P6  POST   /api/remote/pairing                              → PairingCode              (loopback only)
P6  POST   /api/remote/pair                    body { code, name } → { deviceId, deviceToken } (remote only; no token)
P6  GET    /api/remote/devices ; DELETE /api/remote/devices/:id body { confirm }        (loopback only)
P6  GET    /api/remote/away ; POST /api/remote/away body { mode: 'auto'|'on'|'off' } → AwayState
P6  POST   /api/webauthn/register/options | /api/webauthn/register/verify           (remote device only)
P6  POST   /api/webauthn/stepup/options   | /api/webauthn/stepup/verify → { validUntil }
P6  GET    /api/push/vapid-public-key → { publicKey } ; POST /api/push/subscriptions ; DELETE /api/push/subscriptions body { endpoint } ; POST /api/push/test
```

**Error codes:** `loopback_only`, `remote_disabled`, `remote_identity_mismatch`, `remote_bad_host`, `remote_forbidden`, `funnel_detected`, `step_up_required`, `not_owned`, `denied`, `not_approvable`, `invalid_code`, `invalid_token`, `invalid_token_format`, `oauth_not_configured`, `invalid_state`, `unauthenticated`, `upstream_error`, `registration_window_closed`, `unknown_credential`, `bad_push_endpoint`.

**Remote auth:**
- Remote requests authenticate with a **device token**, sent as `x-orc-token` (or `?token=` on WS). The install token is **not** accepted from remote requests.
- The request counts as **remote** when any of these holds:
  - the socket address is not loopback
  - `Tailscale-User-Login` or `Tailscale-User-Name` is present
  - any `X-Forwarded-*` or `Forwarded` header is present
  - the Host hostname is not `127.0.0.1`, `localhost` or `::1`
- `WS /pty/*` is refused for remote requests. `WS /ws` is allowed with a device token.
- The WS Origin allow-list gains `remote.origin`.
- The shared Hono env gains a variable: `OrcApp = Hono<OrcEnv>` with `OrcEnv = { Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } }`, where `RemoteInfo = { deviceId: string | null; deviceName: string | null; login: string }`. Handlers read it through `remoteOf(c)`.
- P1's inline `/api/*` host, Origin and token middleware is skipped for requests that `remoteGuard` already classified as remote. `remoteGuard` runs its own host, Origin, identity and device-token checks.
- `PUBLIC_API_PATHS` (the two OAuth callbacks) skip the token check but not the host check.
- The remote step-up list (`REMOTE_RULES`) covers:
  - `POST /api/sessions/:s/:id/(reply|kill)`
  - `POST /api/sessions/:s/:id/plan/(approve|reject)`
  - `POST /api/inbox/:id/approve`
  - `DELETE /api/pty/:id`
  - `POST /api/ship/merge`

**§6 — bus events (`BusEvent` union additions)**
```ts
| { type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }   // assigned-to-me poller: before=null means newly assigned
| { type: 'slack.mention'; channel: string; ts: string; text: string }
| { type: 'away.changed'; away: boolean; reason: 'manual' | 'idle' | 'present' }
```
`linear.issueChanged` and `slack.mention` use exactly the shapes and file paths that `plan/phase-7-automations-compare-supervisor.md` expects: `connectors/linear/assigned-poller.ts`, `connectors/slack/mention-poller.ts` and `LinearIssue` exported from `connectors/linear/linear.ts`. After Phase 6 merges, Phase 7 **reuses** these and must not add them again.

**§11 — daemon error and audit plumbing**
- `ServiceError.status` gains `502`, used for `upstream_error`.
- New file `apps/daemon/src/services/audit/actor-scope.ts` exports `actorScope: AsyncLocalStorage<{ actor: AuditActor; actorDetail: string | null }>`. P3's `withPtyInputAudit` reads it, so the `pty.input` entries for remote replies carry `actor: 'remote'`.
- `OrcEnv` (in `http/types.ts`) is now `{ Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } }`.

**§11 — interface additions and refinements**
```ts
// connectors/linear/linear.ts  (adds me + invalidate to the §11 interface)
export interface LinearConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; issue(identifier: string): Promise<LinearIssue | null>; comment(identifier: string, markdown: string): Promise<void>; createIssue(i: { teamKey: string; title: string; description: string; assignToMe?: boolean }): Promise<LinearIssue>; assignedToMe(): Promise<LinearIssue[]>; me(): Promise<{ id: string; name: string; email: string }>; invalidate(): void }
// connectors/slack/slack.ts  (me gains label; replies items gain botId/appId; adds reactions, nudge, invalidate)
export interface SlackReply { ts: string; user: string; text: string; botId: string | null; appId: string | null }
export interface SlackConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; me(): Promise<{ userId: string; dmChannelId: string; label: string }>; post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>; replies(channel: string, threadTs: string, afterTs?: string): Promise<SlackReply[]>; mentions(sinceTs: string): Promise<Array<{ channel: string; ts: string; text: string }>>; reactions(channel: string, ts: string): Promise<string[]>; nudge(text: string): Promise<void>; invalidate(): void }
// services/secrets/secret-store.ts — SecretStore as in §11; export function createSecretStore(service?: string): SecretStore (keyring); export function createMemorySecretStore(initial?: Record<string, string>): SecretStore & { dump(): Record<string, string> }; keys: 'linear.token' | 'linear.client_id' | 'linear.client_secret' | 'linear.refresh_token' | 'slack.token' | 'slack.client_id' | 'slack.client_secret'
// services/share/share.ts
export type ShareSource = { kind: 'recap'; sessionPk: string } | { kind: 'handoff'; sessionPk: string } | { kind: 'plan'; planPath: string } | { kind: 'daily'; projectId: string; date: string } | { kind: 'text'; text: string };
export interface ShareService { compose(src: ShareSource): Promise<string>; commentOnLinear(identifier: string, body: string, who: Who): Promise<void>; createFollowUp(i: { sessionPk: string; teamKey: string; title: string; description: string; includeRecap: boolean }, who: Who): Promise<LinearIssue>; postToSlack(channel: string, text: string, who: Who): Promise<{ ts: string }> }
export interface Who { actor: AuditActor; actorDetail: string | null }
// services/remote/session-actions.ts
export interface SessionActions { reply(i: { pk: string; text: string } & Who): Promise<void>; approve(i: { itemId: string } & Who): Promise<InboxItem> }
// services/remote/slack-bridge.ts
export interface SlackBridge { ensureThread(item: InboxItem, url: string): Promise<void>; onInboxUpserted(item: InboxItem): Promise<void>; poll(): Promise<void>; start(): void; stop(): void }
// remote/*
export interface DeviceService { create(name: string, login: string | null): { device: RemoteDeviceRow; token: string }; verify(token: string | null | undefined): RemoteDeviceRow | null; get(id: string): RemoteDeviceRow | null; list(): Array<RemoteDeviceRow & { credentials: number }>; revoke(id: string): boolean }
export interface StepUpStore { grant(deviceId: string): string; valid(deviceId: string): boolean; validUntil(deviceId: string): string | null; revoke(deviceId: string): void }
export interface AwayService { state(): AwayState; setMode(mode: AwayMode): Promise<AwayState>; tick(): Promise<AwayState>; start(): void; stop(): void }
// DaemonContext (§11) gains:  secrets?: SecretStore; share?: ShareService; sessionActions?: SessionActions; away?: AwayService   // P6
```

**§12 — web additions**
- New routes: `/pair`, plus the Settings sections "Connectors" and "Remote".
- On mobile (`max-width: 767px`), a bottom tab bar replaces the left nav and the terminal dock is hidden.
- `api/token.ts#resolveToken()` returns `window.__ORC_TOKEN__`, or the device token stored in `localStorage['orc.deviceToken']`. P1's `getToken()` in `api/client.ts` delegates to it, and `api/client.ts` also exports `resetApiClient()` so the client can be rebuilt after pairing.
- Client methods come from `packages/api-contract/src/client-p6.ts#p6Methods(call: Caller)` and are spread into `createApiClient` like `p2Methods`:
  - connectors: `connectorsList`, `connectorsSetToken`, `connectorsSetApp`, `connectorsAuthorize`, `connectorsDisconnect`
  - Linear and Slack: `linearIssue`, `linearComment`, `linearFollowUp`, `slackPost`
  - sessions and inbox: `sessionsReply`, `inboxApprove`
  - remote: `remoteStatus`, `remoteSetConfig`, `remoteCreatePairing`, `remotePair`, `remoteDevices`, `remoteRevokeDevice`, `awayGet`, `awaySet`
  - WebAuthn: `webauthnRegisterOptions`, `webauthnRegisterVerify`, `webauthnStepUpOptions`, `webauthnStepUpVerify`
  - push: `pushPublicKey`, `pushSubscribe`, `pushUnsubscribe`, `pushTest`
- Query keys: `['connectors']`, `['linear-issue', identifier]`, `['remote-status']`, `['remote-devices']`, `['away']`.
- `api/step-up.ts#withStepUp(fn)` retries once after a passkey assertion when the server answers `step_up_required`.

---

## Assumed earlier-phase interfaces

These names come from the phase plans that were written, cited by file. If the code as built differs, **adapt the call site only**, keep the Phase 6 names, and note the change in the task review note.

| From | Name used here |
|---|---|
| P1 Task 12 `http/types.ts` | `OrcApp = Hono<{ Bindings: HttpBindings }>`. Task 12 of this plan widens it to `OrcEnv`. |
| P1 Task 12 `http/app.ts` | `createApp(o: AppOptions): OrcApp` with `AppOptions { ctx; token; port: () => number; webDist?; env? }`. It holds an inline `app.use('/api/*', …)` host, Origin and token check, plus `app.get('/bootstrap.js', …)` (loopback, allowed Host, `sec-fetch-site`). Routes are added with `register<Area>Routes(app, ctx)`. `app.onError` maps `ServiceError` to the §6 error body. |
| P1 Task 12 `http/auth.ts` | `allowedHosts(port, env?)`, `allowedOrigins(port, env?)`, `tokenMatches(expected, given)`, `isLoopback(addr)` |
| P1 Task 12 `http/json.ts` | `readJson<T>(c, schema): Promise<T>` (throws `ServiceError` 400 `validation_failed`) |
| P1 `services/errors.ts` | `class ServiceError extends Error { code; status: 400\|401\|403\|404\|409\|422\|500; details? }`, constructed as `new ServiceError(code, status, message, details?)` |
| P1 Task 13 `http/ws.ts` + P2 Task 16 | A single `server.on('upgrade', (req, socket, head) => …)` listener that checks token and Origin, then routes `/pty/:ptyId` and `/ws` |
| P1 Task 13 `main.ts` | `createDaemon(o?): Promise<Daemon>`, `Daemon { ctx; indexer; token; start({ port, watch? }) }`. Services are assigned onto `ctx` inside `createDaemon` (P2–P5 add theirs there). |
| P1 Task 11 `test/helpers.ts` | `useTempHomes()` (called at `describe` level) and `createTestContext(overrides?)` → `DaemonContext & { homes; raw; dispose() }`, with `ctx.audit` always set (P3) |
| P1 `services/sessions.ts` | `sessionPk(source, id)` |
| P1 Task 14 `apps/web/src/api/client.ts` | `getApiClient()`, `setApiClientForTests(c \| null)`, `getToken()` (returns `window.__ORC_TOKEN__ ?? ''`) |
| P1 `@/components/ui/*` | `@/components/ui/button` (`Button`, `variant: 'default'\|'outline'\|'secondary'\|'destructive'\|'ghost'`, `size: 'sm'\|'default'`), `@/components/ui/badge` (`Badge`), `@/components/ui/input` (`Input`), `@/components/ui/card` (`Card`) |
| P2 `packages/api-contract/src/client-p2.ts` | `HttpMethod`, `class ApiCallError { status; code; details }`, `type Caller`, `makeCaller(opts)`, `p2Methods(call)`, spread into `createApiClient` |
| P2 §11 | `DaemonContext.updateConfig(fn)`, `LiveTracker`, `InboxEngineRuntime`. `InboxEngine` emits `inbox.upserted` on every state change. |
| P2 inbox items | Dedupe key `${kind}:${sessionPk}`. `payload` carries `{ source, id }`. |
| P2 `notify/notifier.ts` | `createNotifier({ config, log?, debounceMs?, now? })`, `prefFor(cfg, kind)`, `notificationUrl(item, port)`, `NotifyPref`. The `notify()` loop skips `macos` while away. |
| P2 `apps/web/src/test/query.tsx` | `renderWithClient(ui)`, `fakeApi(stubs)`, `makeSession(over)`, `makeQueryClient()` |
| P2 web | `features/inbox/InboxPage.tsx`, `features/live-board/LiveBoard.tsx`, `features/shell/AppShell.tsx` (`AppShell({ children })` with `<header>`, `<nav>` and the terminal dock), `features/settings/SettingsPage.tsx` (renders `<section>`s) |
| P2 kill route | `POST /api/sessions/:source/:id/kill` |
| P3 `services/audit/audit.ts` | `audited()`, `DeniedError` (constructed as `new DeniedError(verdict)`), `createAuditService`. `AuditService.record` redacts params. |
| P3 `pty/audited-pty.ts` | `withPtyInputAudit(pty, audit, { actor? })`. `ctx.pty` is the wrapped manager. |
| P3 `http/audit-middleware.ts` | `NON_ACTION_ROUTES` must list every non-GET route that the middleware does not audit |
| P3 `DenyList` | `ctx.denyList.check(text, projectId)` |
| P3 config | `links.planRoots` (`~`-prefixed paths) |
| P3 web | `features/session-detail/SessionHeader.tsx` receives `session: Session` |
| P4 | `ctx.plans: PlanApprovalService` (`approve(pk)`, `reject(pk, feedback)`), routes `POST /api/sessions/:source/:id/plan/(approve\|reject)` and `POST /api/ship/merge`. Review page `apps/web/src/features/review/ReviewPage.tsx` renders `FileDiff` for each `DiffFileEntry` (`patch` holds the unified text). |
| P5 | `ctx.recaps: RecapService` (`recap(pk, { onDemand })` → `{ text, … }`, `daily(projectId, date)`), `ctx.handoffs: HandoffService` (`latest(pk)`, `generate(pk)`, `toMarkdown(h)`), `ctx.streams: StreamService` (`list({})`). The `streams` Drizzle table (`streams.ticket`, `streams.title`) is in `db/schema.ts`. P5's `refresh()` keeps a non-null `title`. `apps/web/src/features/streams/StreamHeader.tsx` receives `stream: WorkStream`. |

## File Structure (created or modified in this phase)
```
spikes/s9-remote/{package.json,server.ts,index.html,sw.js,slack-probe.ts}      plan/spikes/S9.md
packages/api-contract/src/config.ts                         (modify: RemoteConfig, AwayConfig, ConnectorsConfig)
packages/api-contract/src/routes/{connectors.ts,remote.ts}  + config-p6.test.ts
packages/api-contract/src/client-p6.ts                      (Phase 6 typed client methods)
packages/api-contract/src/{index.ts,client.ts}              (modify: exports, spread phase-6 methods)
apps/daemon/src/live/event-bus.ts                           (modify: BusEvent additions)
apps/daemon/src/http/types.ts                               (modify: OrcEnv with remote variable)
apps/daemon/src/http/p6-util.ts                             (RemoteInfo, remoteOf, whoOf, requireLoopback, confirmOr409)
apps/daemon/src/services/errors.ts                          (modify: status 502)
apps/daemon/src/db/schema-p6.ts  + schema.ts (modify)       + migrations
apps/daemon/src/db/repos/{connectors.ts,remote.ts,slack-threads.ts} + p6-repos.test.ts
apps/daemon/test/p6-fakes.ts
apps/daemon/src/services/secrets/secret-store.ts + test
apps/daemon/src/services/audit/actor-scope.ts ; pty/audited-pty.ts (modify)
apps/daemon/src/connectors/{errors.ts,util.ts,oauth.ts,stream-enricher.ts} + tests
apps/daemon/src/connectors/linear/assigned-poller.ts ; connectors/slack/mention-poller.ts + tests
apps/daemon/src/connectors/linear/{api.ts,linear.ts,oauth.ts} + tests
apps/daemon/src/connectors/slack/{api.ts,slack.ts,text.ts} + tests
apps/daemon/src/services/share/share.ts + test
apps/daemon/src/services/remote/{action-error.ts,session-actions.ts,slack-bridge.ts} + tests
apps/daemon/src/remote/{classify.ts,devices.ts,pairing.ts,step-up.ts,tailscale.ts,webauthn.ts,idle.ts,away.ts} + tests
apps/daemon/src/notify/{format.ts,routing.ts,vapid.ts,webpush.ts,slack-dm.ts} + tests ; notifier.ts (modify)
apps/daemon/src/http/{remote-guard.ts,ws-remote.ts} + tests ; app.ts, ws.ts, audit-middleware.ts (modify)
apps/daemon/src/http/routes/{connectors.ts,share.ts,remote.ts,session-actions.ts,webauthn.ts,push.ts,away.ts} + tests
apps/daemon/src/phase6.ts + test ; main.ts, context.ts (modify)
apps/web/vite.config.ts, index.html, tsconfig.json (modify) ; apps/web/tsconfig.sw.json
apps/web/public/icons/logo.svg (+ generated PNGs)
apps/web/src/sw.ts ; src/pwa/{push-payload.ts,push.ts,register.ts} + tests
apps/web/src/api/{token.ts,step-up.ts} + tests ; api/client.ts (modify)
apps/web/src/api/queries/{connectors.ts,linear.ts,remote.ts}
apps/web/src/features/settings/ConnectorsPanel.tsx + test
apps/web/src/features/share/{ShareDialog.tsx,FollowUpDialog.tsx,SessionShareActions.tsx} + test
apps/web/src/features/linear/LinearIssueChip.tsx
apps/web/src/features/remote/{PairPage.tsx,RemotePanel.tsx} + test ; routes/pair.tsx
apps/web/src/features/mobile/{useIsMobile.ts,MobileNav.tsx,ReplyComposer.tsx,InboxItemMobileCard.tsx,ReadOnlyDiff.tsx} + tests
apps/web/e2e/mobile.spec.ts
docs/setup-remote-and-connectors.md
```

---

### Task 1: Spike S9 — Tailscale serve, PWA push, passkeys and Slack self-DM (go/no-go)

**Files:**
- Create: `spikes/s9-remote/package.json`, `spikes/s9-remote/server.ts`, `spikes/s9-remote/index.html`, `spikes/s9-remote/sw.js`, `spikes/s9-remote/slack-probe.ts`
- Create: `plan/spikes/S9.md`

**Interfaces:**
- Consumes: nothing from the workspace.
- Produces: a **go/no-go** plus these recorded facts, which later tasks read:
  - (b) which headers `tailscale serve` actually sends (`Tailscale-User-Login`, `X-Forwarded-For/Host/Proto`, `Host`, socket address), used by `isRemoteRequest` (Task 12)
  - (c) whether client-supplied `Tailscale-*` headers are stripped
  - (d) whether Web Push works on iOS and Android
  - (e) passkey registration and assertion with rpID = MagicDNS host
  - (g) Slack facts: http redirect accepted? self-DM notifies? `app_id` on messages posted with a user token? does the reminder nudge work?
  - (h) the `tailscale serve status --json` shape, including `AllowFunnel`

- [ ] **Step 1: Create the spike package**

`spikes/s9-remote/package.json`
```json
{
  "name": "spike-s9-remote",
  "private": true,
  "type": "module",
  "scripts": { "serve": "tsx server.ts", "slack": "tsx slack-probe.ts" },
  "dependencies": { "@simplewebauthn/server": "^14.0.2", "@slack/web-api": "^8.1.1", "web-push": "^3.6.7" },
  "devDependencies": { "@types/web-push": "^3.6.4", "tsx": "^4.23.13" }
}
```

- [ ] **Step 2: Write the header-echo, push and passkey server (binds 127.0.0.1 only)**

`spikes/s9-remote/server.ts`
```ts
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import webpush from 'web-push';

const ORIGIN = process.env.S9_ORIGIN;
if (!ORIGIN) throw new Error('set S9_ORIGIN=https://<machine>.<tailnet>.ts.net');
const RP_ID = new URL(ORIGIN).hostname;
const dir = import.meta.dirname;
const vapid = webpush.generateVAPIDKeys();
const subject = `mailto:${process.env.S9_LOGIN ?? 'you@example.com'}`;
const subs: webpush.PushSubscription[] = [];
const creds: WebAuthnCredential[] = [];
let challenge = '';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data, null, 2) : String(data));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://spike.local');
  console.log(
    new Date().toISOString(),
    req.method,
    url.pathname,
    JSON.stringify({
      socket: req.socket.remoteAddress,
      host: req.headers.host,
      xff: req.headers['x-forwarded-for'],
      xfh: req.headers['x-forwarded-host'],
      xfp: req.headers['x-forwarded-proto'],
      login: req.headers['tailscale-user-login'],
      origin: req.headers.origin,
    }),
  );
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, readFileSync(join(dir, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/sw.js') {
      return send(res, 200, readFileSync(join(dir, 'sw.js'), 'utf8'), 'text/javascript');
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const manifest = { name: 'S9 spike', short_name: 'S9', start_url: '/', display: 'standalone', background_color: '#111827', theme_color: '#111827', icons: [] };
      return send(res, 200, JSON.stringify(manifest), 'application/manifest+json');
    }
    if (url.pathname === '/headers') return send(res, 200, { socket: req.socket.remoteAddress, headers: req.headers });
    if (url.pathname === '/vapid') return send(res, 200, { publicKey: vapid.publicKey });
    if (req.method === 'POST' && url.pathname === '/subscribe') {
      subs.push((await readBody(req)) as webpush.PushSubscription);
      return send(res, 200, { count: subs.length });
    }
    if (req.method === 'POST' && url.pathname === '/push') {
      const payload = JSON.stringify({ title: 'S9 push', body: `sent ${new Date().toISOString()}`, url: `${ORIGIN}/?from=push` });
      const results = await Promise.allSettled(
        subs.map((s) =>
          webpush.sendNotification(s, payload, {
            vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
            TTL: 600,
            urgency: 'high',
          }),
        ),
      );
      return send(res, 200, results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : String(r.reason))));
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/reg-options') {
      const o = await generateRegistrationOptions({
        rpName: 'S9 spike',
        rpID: RP_ID,
        userName: 's9-user',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      challenge = o.challenge;
      return send(res, 200, o);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/reg-verify') {
      const v = await verifyRegistrationResponse({
        response: (await readBody(req)) as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
      if (v.verified) creds.push(v.registrationInfo.credential);
      return send(res, 200, { verified: v.verified, credentials: creds.length });
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/auth-options') {
      const o = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
      });
      challenge = o.challenge;
      return send(res, 200, o);
    }
    if (req.method === 'POST' && url.pathname === '/webauthn/auth-verify') {
      const r = (await readBody(req)) as AuthenticationResponseJSON;
      const cred = creds.find((c) => c.id === r.id);
      if (!cred) return send(res, 404, { error: 'unknown credential' });
      const v = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: cred,
        requireUserVerification: true,
      });
      cred.counter = v.authenticationInfo.newCounter;
      return send(res, 200, { verified: v.verified });
    }
    if (req.method === 'POST' && url.pathname === '/reply') {
      const b = (await readBody(req)) as { text?: string };
      console.log('REPLY RECEIVED:', b.text);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e) });
  }
}).listen(4399, '127.0.0.1', () => console.log(`S9 spike on http://127.0.0.1:4399 — serve it at ${ORIGIN}`));
```

`spikes/s9-remote/sw.js`
```js
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'S9', body: '(no payload)', url: '/' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
```

`spikes/s9-remote/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>S9</title>
  </head>
  <body style="font-family: system-ui; padding: 16px">
    <h1>S9 remote spike</h1>
    <p>
      <button id="h">Headers</button> <button id="p">Enable push</button> <button id="t">Send test push</button>
    </p>
    <p><button id="r">Register passkey</button> <button id="a">Step-up</button></p>
    <p><input id="txt" value="yes, continue" /> <button id="s">Send reply</button></p>
    <pre id="out"></pre>
    <script type="module">
      import { startAuthentication, startRegistration } from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@14.0.0/+esm';
      const out = (v) => { document.getElementById('out').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
      const post = async (p, b) => (await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json();
      const b64 = (s) => {
        const pad = '='.repeat((4 - (s.length % 4)) % 4);
        const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, (c) => c.charCodeAt(0));
      };
      await navigator.serviceWorker.register('/sw.js');
      document.getElementById('h').onclick = async () => out(await (await fetch('/headers')).json());
      document.getElementById('p').onclick = async () => {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return out(`permission: ${perm}`);
        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await (await fetch('/vapid')).json();
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
        out(await post('/subscribe', sub.toJSON()));
      };
      document.getElementById('t').onclick = async () => out(await post('/push'));
      document.getElementById('r').onclick = async () => {
        const o = await post('/webauthn/reg-options');
        out(await post('/webauthn/reg-verify', await startRegistration({ optionsJSON: o })));
      };
      document.getElementById('a').onclick = async () => {
        const o = await post('/webauthn/auth-options');
        out(await post('/webauthn/auth-verify', await startAuthentication({ optionsJSON: o })));
      };
      document.getElementById('s').onclick = async () => out(await post('/reply', { text: document.getElementById('txt').value }));
    </script>
  </body>
</html>
```

- [ ] **Step 3: Write the Slack probe (uses a real user token from the environment, never written to disk)**

`spikes/s9-remote/slack-probe.ts`
```ts
import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_USER_TOKEN;
if (!token?.startsWith('xoxp-')) throw new Error('set SLACK_USER_TOKEN=xoxp-… (User OAuth Token from the Slack app)');
const slack = new WebClient(token);

const auth = await slack.auth.test();
const userId = String(auth.user_id);
const dm = await slack.conversations.open({ users: userId });
const channel = String(dm.channel?.id);
const root = await slack.chat.postMessage({
  channel,
  text: 'S9 probe: reply "hello" in this thread from your phone, react with :white_check_mark:, then press Enter in the terminal.',
});
const posted = (root.message ?? {}) as Record<string, unknown>;
console.log({ userId, channel, rootTs: root.ts, postedKeys: Object.keys(posted), appId: posted.app_id, botId: posted.bot_id });
console.log('Did your phone show a Slack notification for this self-DM? Note it in S9.md (check g2).');

process.stdin.once('data', async () => {
  const r = await slack.conversations.replies({ channel, ts: String(root.ts), limit: 50 });
  for (const m of r.messages ?? []) {
    const mm = m as Record<string, unknown>;
    console.log({ ts: mm.ts, user: mm.user, app_id: mm.app_id, bot_id: mm.bot_id, subtype: mm.subtype, text: mm.text, reactions: mm.reactions });
  }
  if (process.env.S9_TRY_REMINDER === '1') {
    const rem = await slack.reminders.add({ text: 'S9 reminder nudge', time: Math.floor(Date.now() / 1000) + 60 });
    console.log('reminder', rem.ok, 'Did the Slackbot reminder notify your phone ~60 s later? (check g4)');
  }
  process.exit(0);
});
```

- [ ] **Step 4: Run the checks**

Run:
```bash
cd /Users/hazem/orchestrator/spikes/s9-remote && pnpm install --ignore-workspace
tailscale serve --bg http://127.0.0.1:4399
tailscale serve status --json > /tmp/s9-serve-status.json; cat /tmp/s9-serve-status.json
S9_ORIGIN="https://$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')" S9_LOGIN="<your tailnet login>" pnpm serve
```
Expected: `tailscale serve status` shows `https://<machine>.<tailnet>.ts.net` → `http://127.0.0.1:4399`, and the server logs `S9 spike on http://127.0.0.1:4399`.

Then work through the checklist. Paste each result into the report.

| # | Check | How |
|---|---|---|
| a | Reachable in the tailnet only | Phone with Tailscale on: open the origin → the page loads. Phone with Tailscale **off** (cellular): the page does not load. `curl -sI https://<origin>` from a machine outside the tailnet fails. |
| b | Headers seen by the backend | Tap **Headers** on the phone. Record `socket`, `host`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto` and `tailscale-user-login`. |
| c | Spoofed identity is stripped | From another tailnet device: `curl -s -H 'Tailscale-User-Login: evil@example.com' https://<origin>/headers` → the response shows the **real** login, or none for a tagged device. |
| d1 | Android Chrome push | **Enable push** → **Send test push** → a notification arrives. Tapping it opens `/?from=push`. |
| d2 | iOS push | Safari → Share → **Add to Home Screen** → open the installed app → **Enable push** → **Send test push** (with the phone locked) → a notification arrives. Tapping it opens the app. |
| e1 | Passkey on the phone | **Register passkey** → Face ID → `verified: true`. Then **Step-up** → `verified: true`. |
| e2 | Passkey on the Mac through the origin | The same flow in desktop Safari/Chrome at the ts.net origin. Note whether the iCloud Keychain passkey also shows on the phone. |
| f | Reply path | **Send reply** → the server logs `REPLY RECEIVED: yes, continue`. |
| g1 | Slack redirect | In the Slack app's **OAuth & Permissions**, add `http://127.0.0.1:4317/api/connectors/slack/callback`. Record whether Slack accepts it. |
| g2 | Self-DM notification | `SLACK_USER_TOKEN=xoxp-… pnpm slack` → does the phone notify for the self-DM? |
| g3 | Message fields | From the probe output: does a message posted with the user token have `app_id` or `bot_id`? Does your typed reply have neither? |
| g4 | Reminder nudge | `S9_TRY_REMINDER=1 SLACK_USER_TOKEN=… pnpm slack` → does the Slackbot reminder notify the phone? |
| h | Funnel detection | `tailscale funnel --bg 4399` **for 30 seconds only**, then `tailscale serve status --json` → record the `AllowFunnel` key. Then run `tailscale funnel --https=443 off`, and confirm `AllowFunnel` is gone. |

Clean up: `tailscale serve --https=443 off`.

- [ ] **Step 5: Write the report**

`plan/spikes/S9.md` (fill in every line):
```markdown
# S9 — Remote access (Tailscale serve, PWA push, passkeys, Slack DM)
Date: <run date> · tailscale <`tailscale version`> · iOS <ver> · Android <ver>
| # | result | notes |
|---|---|---|
| a | pass/fail | |
| b | socket=… host=… xff=… xfh=… xfp=… login=… | |
| c | pass/fail | |
| d1 / d2 | pass/fail / pass/fail | |
| e1 / e2 | pass/fail / pass/fail | synced to phone? |
| f | pass/fail | |
| g1 | accepted/rejected | |
| g2 / g3 / g4 | yes/no · app_id on posted=…, on typed=… · yes/no | |
| h | AllowFunnel shape: … | |
## Decision
GO when a, b (login present), c, e1 and f pass, and at least one of d1/d2 passes.
Consequences that must be applied to this plan (record in the Task 12/15/16 review notes):
- b: if no X-Forwarded-* header appears, isRemoteRequest still classifies via Tailscale-User-Login + Host; if Host is rewritten to 127.0.0.1 AND no X-Forwarded-Host appears, set `remoteGuard` host check to accept `127.0.0.1:<port>` only when Tailscale-User-Login is present.
- d2 fail: Slack DM is the primary phone channel; document "iOS push unsupported" in Settings → Remote.
- g1 rejected: default `connectors.slack.redirectUri` stays, but Settings shows "use the ts.net redirect or paste the token".
- g2 no + g4 yes: set the default of `connectors.slack.nudgeViaReminder` to `true` in Task 2.
- g3: if typed replies can carry app_id, remove the appId filter in Task 16 and rely on the posted-ts list only.
- h: if the key is not `AllowFunnel`, update `detectFunnel()` in Task 12.
NO-GO: stop Phase 6 remote tasks (12–19); connectors (2–11) and the Slack DM bridge (16) can still ship.
```

- [ ] **Step 6: Commit**

```bash
cd /Users/hazem/orchestrator
git checkout -b phase/6-linear-slack-remote
git add spikes/s9-remote/package.json spikes/s9-remote/server.ts spikes/s9-remote/index.html spikes/s9-remote/sw.js spikes/s9-remote/slack-probe.ts plan/spikes/S9.md
git commit -m "chore(spike): S9 remote access, push, passkeys and Slack DM report"
```

---

### Task 2: Contract additions — config, route schemas, client methods, bus events, shared HTTP helpers

**Files:**
- Modify: `packages/api-contract/src/config.ts`, `packages/api-contract/src/client.ts`, `packages/api-contract/src/index.ts`
- Create: `packages/api-contract/src/routes/connectors.ts`, `packages/api-contract/src/routes/remote.ts`, `packages/api-contract/src/client-p6.ts`, `packages/api-contract/src/p6-contract.test.ts`
- Modify: `apps/daemon/src/live/event-bus.ts`, `apps/daemon/src/http/types.ts`, `apps/daemon/src/services/errors.ts`, `apps/daemon/src/context.ts`
- Create: `apps/daemon/src/http/p6-util.ts`

**Interfaces:**
- Consumes:
  - `Caller` and `p2Methods` from `client-p2.ts` (P2)
  - `InboxItem`, `Source`, `AuditActor` from `@orc/core`
  - `ServiceError` (P1)
  - `HttpBindings` from `@hono/node-server`
- Produces:
  - api-contract config: `RemoteConfig`, `AwayConfig`, `ConnectorsConfig`, and the `OrcConfig` fields `remote`, `away`, `connectors`
  - api-contract connector schemas:
    ```ts
    ConnectorId, ConnectorStatus, TokenBody, OAuthAppBody, ConfirmBody, LinearIssue, ShareSource, LinearCommentBody, LinearFollowUpBody, SlackPostBody
    // types: ConnectorId, ConnectorStatus, LinearIssue, ShareSource
    ```
  - api-contract remote schemas:
    ```ts
    PairBody, PairResult, PairingCode, RemoteDevice, RemoteConfigBody, RemoteStatus, AwayMode, AwayState, AwayBody, ReplyBody, ApproveBody, PushSubscriptionBody, PushUnsubscribeBody, StepUpResult, WebAuthnVerifyBody
    // types of the same names
    ```
  - api-contract client: `p6Methods(call: Caller)` (method list in Contract additions §12) and `isApiErrorWithCode(e: unknown, code: string): e is { status: number; code: string; message: string; details?: unknown }`
  - daemon, `live/event-bus.ts`: the `BusEvent` additions `linear.issueChanged`, `slack.mention`, `away.changed`
  - daemon, `http/types.ts`:
    ```ts
    export type OrcEnv = { Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } }
    export type OrcApp = Hono<OrcEnv>
    ```
  - daemon, `http/p6-util.ts`:
    ```ts
    export interface RemoteInfo { deviceId: string | null; deviceName: string | null; login: string }
    export interface Who { actor: AuditActor; actorDetail: string | null }
    export function remoteOf(c: Context<OrcEnv>): RemoteInfo | null
    export function whoOf(c: Context<OrcEnv>): Who
    export function requireLoopback(c: Context<OrcEnv>): void                      // ServiceError 403 loopback_only
    export function requireRemoteDevice(c: Context<OrcEnv>): RemoteInfo & { deviceId: string }   // ServiceError 403 remote_only
    export function confirmOr409(confirm: boolean | undefined, summary: string, extra?: Record<string, unknown>): void
    export function need<T>(v: T | undefined, name: string): T                     // ServiceError 500 unavailable
    ```
  - `ServiceError.status` gains `502`
  - `DaemonContext` gains `secrets?`, `share?`, `sessionActions?`, `away?`, `linear?` and `slack?`, using the Phase 6 types

- [ ] **Step 1: Write the failing contract test**

`packages/api-contract/src/p6-contract.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Caller } from './client-p2.ts';
import { isApiErrorWithCode, p6Methods } from './client-p6.ts';
import { OrcConfig } from './config.ts';
import { LinearCommentBody, LinearFollowUpBody, ShareSource, SlackPostBody, TokenBody } from './routes/connectors.ts';
import { AwayBody, PairBody, PushSubscriptionBody, RemoteConfigBody } from './routes/remote.ts';

describe('phase 6 config', () => {
  it('fills remote, away and connector defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.remote).toEqual({ enabled: false, origin: null, allowedLogin: null, stepUpTtlSec: 300, pairingTtlSec: 300 });
    expect(c.away).toEqual({ auto: true, idleMinutes: 10, channels: ['webpush', 'slack_dm'] });
    expect(c.connectors.slack).toMatchObject({
      enabled: true,
      redirectUri: 'http://127.0.0.1:4317/api/connectors/slack/callback',
      dmBridge: true,
      bridgePollSeconds: 15,
      nudgeViaReminder: false,
      dailyChannel: null,
    });
    expect(c.connectors.linear).toMatchObject({ enabled: true, pollSeconds: 120, defaultTeamKey: null });
  });

  it('keeps partial connector config and fills the rest', () => {
    const c = OrcConfig.parse({ connectors: { slack: { dailyChannel: 'C0123456' } } });
    expect(c.connectors.slack.dailyChannel).toBe('C0123456');
    expect(c.connectors.slack.pollSeconds).toBe(60);
    expect(c.connectors.linear.pollSeconds).toBe(120);
  });
});

describe('phase 6 schemas', () => {
  it('validates share sources', () => {
    expect(ShareSource.parse({ kind: 'recap', sessionPk: 'claude:s1' })).toEqual({ kind: 'recap', sessionPk: 'claude:s1' });
    expect(ShareSource.safeParse({ kind: 'daily', projectId: 'wakecap', date: '17-09-2026' }).success).toBe(false);
    expect(ShareSource.safeParse({ kind: 'text', text: '' }).success).toBe(false);
    expect(LinearCommentBody.parse({ source: { kind: 'text', text: 'hi' } }).confirm).toBeUndefined();
  });

  it('validates follow-up and slack bodies', () => {
    const f = LinearFollowUpBody.parse({ sessionPk: 'claude:s1', title: 'Fix flaky test' });
    expect(f).toMatchObject({ description: '', includeRecap: true });
    expect(LinearFollowUpBody.safeParse({ sessionPk: 'claude:s1', title: 'x', teamKey: 'saf' }).success).toBe(false);
    expect(SlackPostBody.safeParse({ channel: '#general', source: { kind: 'text', text: 'x' } }).success).toBe(false);
    expect(SlackPostBody.parse({ channel: 'C0123ABCD', source: { kind: 'text', text: 'x' } }).channel).toBe('C0123ABCD');
  });

  it('validates remote bodies', () => {
    expect(PairBody.safeParse({ code: 'ABCD2345', name: 'Phone' }).success).toBe(true);
    expect(PairBody.safeParse({ code: 'abcd0000', name: 'Phone' }).success).toBe(false);
    expect(TokenBody.safeParse({ token: 'short' }).success).toBe(false);
    expect(AwayBody.parse({ mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(RemoteConfigBody.safeParse({ enabled: true, origin: 'http://mac.ts.net', allowedLogin: 'me@example.com' }).success).toBe(false);
    expect(RemoteConfigBody.parse({ enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' }).origin).toBe(
      'https://mac.tail1234.ts.net',
    );
    expect(
      PushSubscriptionBody.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BExampleKey123', auth: 'authsecret1' } })
        .success,
    ).toBe(true);
  });
});

describe('p6Methods', () => {
  it('maps methods to routes', async () => {
    const call = vi.fn(async () => ({ ok: true })) as unknown as Caller & ReturnType<typeof vi.fn>;
    const api = p6Methods(call);
    await api.connectorsSetToken('slack', 'xoxp-1234567890');
    await api.sessionsReply('claude', 's/1', 'yes');
    await api.inboxApprove('i1');
    await api.pushUnsubscribe('https://push.example/1');
    await api.remoteRevokeDevice('d1');
    expect(call.mock.calls).toEqual([
      ['POST', '/api/connectors/slack/token', { token: 'xoxp-1234567890' }],
      ['POST', '/api/sessions/claude/s%2F1/reply', { text: 'yes' }],
      ['POST', '/api/inbox/i1/approve', { confirm: true }],
      ['DELETE', '/api/push/subscriptions', { endpoint: 'https://push.example/1' }],
      ['DELETE', '/api/remote/devices/d1', { confirm: true }],
    ]);
  });

  it('recognises API error codes', () => {
    expect(isApiErrorWithCode({ status: 401, code: 'step_up_required', message: 'x' }, 'step_up_required')).toBe(true);
    expect(isApiErrorWithCode(new Error('x'), 'step_up_required')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/p6-contract.test.ts`
Expected: FAIL, `Cannot find module './client-p6.ts'`

- [ ] **Step 3: Add the config schemas**

In `packages/api-contract/src/config.ts`, add the three schemas exactly as written in **Contract additions §3** above `OrcConfig`, and add these three fields inside `OrcConfig`'s `z.object({ … })`:
```ts
  remote: RemoteConfig.prefault({}),
  away: AwayConfig.prefault({}),
  connectors: ConnectorsConfig.prefault({}),
```
Then append:
```ts
export type RemoteConfig = z.infer<typeof RemoteConfig>;
export type AwayConfig = z.infer<typeof AwayConfig>;
export type ConnectorsConfig = z.infer<typeof ConnectorsConfig>;
```

- [ ] **Step 4: Write the route schemas**

`packages/api-contract/src/routes/connectors.ts`
```ts
import { z } from 'zod';

export const ConnectorId = z.enum(['linear', 'slack']);
export type ConnectorId = z.infer<typeof ConnectorId>;

export const ConnectorStatus = z.object({
  id: ConnectorId,
  connected: z.boolean(),
  status: z.enum(['ok', 'unauthenticated', 'error']),
  authKind: z.enum(['api_key', 'oauth', 'user_token']).nullable(),
  accountLabel: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  oauthConfigured: z.boolean(),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const TokenBody = z.object({ token: z.string().trim().min(12).max(500) });
export const OAuthAppBody = z.object({ clientId: z.string().trim().min(5).max(200), clientSecret: z.string().trim().min(10).max(500) });
export const ConfirmBody = z.object({ confirm: z.boolean().optional() });

export const LinearIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  state: z.string(),
  assignee: z.string().nullable(),
  url: z.string(),
  labels: z.array(z.string()),
});
export type LinearIssue = z.infer<typeof LinearIssue>;

export const ShareSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recap'), sessionPk: z.string().min(3) }),
  z.object({ kind: z.literal('handoff'), sessionPk: z.string().min(3) }),
  z.object({ kind: z.literal('plan'), planPath: z.string().min(1) }),
  z.object({ kind: z.literal('daily'), projectId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(20000) }),
]);
export type ShareSource = z.infer<typeof ShareSource>;

export const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

export const LinearCommentBody = z.object({ source: ShareSource, confirm: z.boolean().optional() });
export const LinearFollowUpBody = z.object({
  sessionPk: z.string().min(3),
  teamKey: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/).optional(),
  title: z.string().trim().min(3).max(250),
  description: z.string().max(20000).default(''),
  includeRecap: z.boolean().default(true),
  confirm: z.boolean().optional(),
});
export const SlackPostBody = z.object({
  channel: z.string().regex(/^[CGD][A-Z0-9]{6,}$/).optional(),
  source: ShareSource,
  confirm: z.boolean().optional(),
});
```

`packages/api-contract/src/routes/remote.ts`
```ts
import { z } from 'zod';

export const PairBody = z.object({ code: z.string().regex(/^[A-Z2-9]{8}$/), name: z.string().trim().min(1).max(60) });
export const PairResult = z.object({ deviceId: z.string(), deviceToken: z.string() });
export type PairResult = z.infer<typeof PairResult>;
export const PairingCode = z.object({ code: z.string(), expiresAt: z.string(), url: z.string().nullable() });
export type PairingCode = z.infer<typeof PairingCode>;

export const RemoteDevice = z.object({
  id: z.string(),
  name: z.string(),
  login: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  credentials: z.number().int(),
});
export type RemoteDevice = z.infer<typeof RemoteDevice>;

export const RemoteConfigBody = z.object({
  enabled: z.boolean(),
  origin: z
    .string()
    .regex(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/)
    .nullable(),
  allowedLogin: z.string().trim().min(3).max(200).nullable(),
});
export type RemoteConfigBody = z.infer<typeof RemoteConfigBody>;

export const RemoteStatus = z.object({
  enabled: z.boolean(),
  origin: z.string().nullable(),
  allowedLogin: z.string().nullable(),
  isRemote: z.boolean(),
  deviceId: z.string().nullable(),
  stepUpValidUntil: z.string().nullable(),
  funnelDetected: z.boolean(),
  pairingActiveUntil: z.string().nullable(),
});
export type RemoteStatus = z.infer<typeof RemoteStatus>;

export const AwayMode = z.enum(['auto', 'on', 'off']);
export type AwayMode = z.infer<typeof AwayMode>;
export const AwayState = z.object({
  away: z.boolean(),
  mode: AwayMode,
  reason: z.enum(['manual', 'idle', 'present']),
  idleSeconds: z.number().nullable(),
});
export type AwayState = z.infer<typeof AwayState>;
export const AwayBody = z.object({ mode: AwayMode });

export const ReplyBody = z.object({ text: z.string().trim().min(1).max(8000) });
export const ApproveBody = z.object({ confirm: z.boolean().optional() });

export const PushSubscriptionBody = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(8) }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;
export const PushUnsubscribeBody = z.object({ endpoint: z.url() });

export const StepUpResult = z.object({ validUntil: z.string() });
export type StepUpResult = z.infer<typeof StepUpResult>;
export const WebAuthnVerifyBody = z.object({ response: z.record(z.string(), z.unknown()) });
```

- [ ] **Step 5: Write the client methods**

`packages/api-contract/src/client-p6.ts`
```ts
import type { InboxItem, Source } from '@orc/core';
import type { z } from 'zod';
import type { Caller } from './client-p2.ts';
import type {
  ConnectorId,
  ConnectorStatus,
  LinearFollowUpBody,
  LinearIssue,
  ShareSource,
  SlackPostBody,
} from './routes/connectors.ts';
import type {
  AwayMode,
  AwayState,
  PairResult,
  PairingCode,
  PushSubscriptionBody,
  RemoteConfigBody,
  RemoteDevice,
  RemoteStatus,
  StepUpResult,
} from './routes/remote.ts';

const enc = encodeURIComponent;

export function p6Methods(call: Caller) {
  return {
    connectorsList: () => call<ConnectorStatus[]>('GET', '/api/connectors'),
    connectorsSetToken: (id: ConnectorId, token: string) =>
      call<ConnectorStatus>('POST', `/api/connectors/${id}/token`, { token }),
    connectorsSetApp: (id: ConnectorId, clientId: string, clientSecret: string) =>
      call<{ ok: true }>('POST', `/api/connectors/${id}/app`, { clientId, clientSecret }),
    connectorsAuthorize: (id: ConnectorId) => call<{ url: string }>('GET', `/api/connectors/${id}/authorize`),
    connectorsDisconnect: (id: ConnectorId, confirm: boolean) =>
      call<{ ok: true }>('DELETE', `/api/connectors/${id}`, { confirm }),
    linearIssue: (identifier: string) => call<LinearIssue>('GET', `/api/linear/issues/${enc(identifier)}`),
    linearComment: (identifier: string, source: ShareSource, confirm: boolean) =>
      call<{ ok: true }>('POST', `/api/linear/issues/${enc(identifier)}/comment`, { source, confirm }),
    linearFollowUp: (body: z.input<typeof LinearFollowUpBody>) => call<LinearIssue>('POST', '/api/linear/follow-up', body),
    slackPost: (body: z.input<typeof SlackPostBody>) => call<{ ts: string }>('POST', '/api/slack/post', body),
    sessionsReply: (source: Source, id: string, text: string) =>
      call<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/reply`, { text }),
    inboxApprove: (id: string) => call<InboxItem>('POST', `/api/inbox/${enc(id)}/approve`, { confirm: true }),
    remoteStatus: () => call<RemoteStatus>('GET', '/api/remote/status'),
    remoteSetConfig: (body: RemoteConfigBody) => call<RemoteStatus>('POST', '/api/remote/config', body),
    remoteCreatePairing: () => call<PairingCode>('POST', '/api/remote/pairing', {}),
    remotePair: (code: string, name: string) => call<PairResult>('POST', '/api/remote/pair', { code, name }),
    remoteDevices: () => call<RemoteDevice[]>('GET', '/api/remote/devices'),
    remoteRevokeDevice: (id: string) => call<{ ok: true }>('DELETE', `/api/remote/devices/${enc(id)}`, { confirm: true }),
    awayGet: () => call<AwayState>('GET', '/api/remote/away'),
    awaySet: (mode: AwayMode) => call<AwayState>('POST', '/api/remote/away', { mode }),
    webauthnRegisterOptions: <T = Record<string, unknown>>() => call<T>('POST', '/api/webauthn/register/options', {}),
    webauthnRegisterVerify: (response: unknown) =>
      call<{ credentialId: string }>('POST', '/api/webauthn/register/verify', { response }),
    webauthnStepUpOptions: <T = Record<string, unknown>>() => call<T>('POST', '/api/webauthn/stepup/options', {}),
    webauthnStepUpVerify: (response: unknown) => call<StepUpResult>('POST', '/api/webauthn/stepup/verify', { response }),
    pushPublicKey: () => call<{ publicKey: string }>('GET', '/api/push/vapid-public-key'),
    pushSubscribe: (sub: PushSubscriptionBody) => call<{ ok: true }>('POST', '/api/push/subscriptions', sub),
    pushUnsubscribe: (endpoint: string) => call<{ ok: true }>('DELETE', '/api/push/subscriptions', { endpoint }),
    pushTest: () => call<{ sent: number }>('POST', '/api/push/test', {}),
  };
}

export type P6Methods = ReturnType<typeof p6Methods>;

export function isApiErrorWithCode(
  e: unknown,
  code: string,
): e is { status: number; code: string; message: string; details?: unknown } {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}
```

In `packages/api-contract/src/client.ts`, in `createApiClient`, use the same `Caller` that P2 passes to `p2Methods`, and spread the Phase 6 methods right after P2's:
```ts
    ...p6Methods(caller),
```
Add `import { p6Methods } from './client-p6.ts';`. Here `caller` is the P2 variable holding `makeCaller({ baseUrl: o.baseUrl, token: o.token })`.

Append to `packages/api-contract/src/index.ts`:
```ts
export * from './client-p6.ts';
export * from './routes/connectors.ts';
export * from './routes/remote.ts';
```

- [ ] **Step 6: Run the contract test and confirm it passes**

Run: `pnpm vitest run packages/api-contract/src/p6-contract.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Add the daemon-side contract pieces**

In `apps/daemon/src/live/event-bus.ts`, add `import type { LinearIssue } from '@orc/api-contract';` and extend the `BusEvent` union:
```ts
  | { type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }
  | { type: 'slack.mention'; channel: string; ts: string; text: string }
  | { type: 'away.changed'; away: boolean; reason: 'manual' | 'idle' | 'present' }
```

In `apps/daemon/src/services/errors.ts`, widen the status union of `ServiceError` to `400 | 401 | 403 | 404 | 409 | 422 | 500 | 502`.

`apps/daemon/src/http/types.ts` (replace the file):
```ts
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type { RemoteInfo } from './p6-util.ts';

export type OrcEnv = { Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } };
export type OrcApp = Hono<OrcEnv>;
```
In `apps/daemon/src/http/app.ts`, change `new Hono<{ Bindings: HttpBindings }>()` to `new Hono<OrcEnv>()` and import `OrcEnv` from `./types.ts`.

`apps/daemon/src/http/p6-util.ts`
```ts
import type { AuditActor } from '@orc/core';
import type { Context } from 'hono';
import { ServiceError } from '../services/errors.ts';
import type { OrcEnv } from './types.ts';

export interface RemoteInfo {
  deviceId: string | null;
  deviceName: string | null;
  login: string;
}

export interface Who {
  actor: AuditActor;
  actorDetail: string | null;
}

export function remoteOf(c: Context<OrcEnv>): RemoteInfo | null {
  return c.get('remote') ?? null;
}

export function whoOf(c: Context<OrcEnv>): Who {
  const r = remoteOf(c);
  if (!r) return { actor: 'user', actorDetail: null };
  return { actor: 'remote', actorDetail: `${r.deviceName ?? 'unpaired device'} (${r.login})` };
}

export function requireLoopback(c: Context<OrcEnv>): void {
  if (remoteOf(c)) throw new ServiceError('loopback_only', 403, 'only available on this Mac');
}

export function requireRemoteDevice(c: Context<OrcEnv>): RemoteInfo & { deviceId: string } {
  const r = remoteOf(c);
  if (!r || r.deviceId === null) throw new ServiceError('remote_only', 403, 'open this page on a paired device');
  return { ...r, deviceId: r.deviceId };
}

export function confirmOr409(confirm: boolean | undefined, summary: string, extra: Record<string, unknown> = {}): void {
  if (confirm !== true) {
    throw new ServiceError('confirmation_required', 409, 'confirm to continue', { summary, ...extra });
  }
}

export function need<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new ServiceError('unavailable', 500, `${name} is not wired`);
  return v;
}
```

In `apps/daemon/src/context.ts`, add these type imports and optional fields to `DaemonContext`. `linear?` and `slack?` already exist; update only their import paths.
```ts
import type { LinearConnector } from './connectors/linear/linear.ts';
import type { SlackConnector } from './connectors/slack/slack.ts';
import type { AwayService } from './remote/away.ts';
import type { SessionActions } from './services/remote/session-actions.ts';
import type { SecretStore } from './services/secrets/secret-store.ts';
import type { ShareService } from './services/share/share.ts';
// inside DaemonContext:
  secrets?: SecretStore;                   // P6
  share?: ShareService;                    // P6
  sessionActions?: SessionActions;         // P6
  away?: AwayService;                      // P6
  linear?: LinearConnector;                // P6
  slack?: SlackConnector;                  // P6
```
These imports refer to files created in Tasks 4, 5, 6, 9, 13 and 17. `pnpm typecheck` stays red until Task 17. Run `pnpm --filter @orc/api-contract typecheck` in this task, and do the full typecheck at the end of Task 17.

**Keep the repo green until then:** in this task, create each missing file as a one-line type stub that the owning task replaces:
- `apps/daemon/src/connectors/linear/linear.ts`: `export interface LinearConnector { status(): Promise<'ok' | 'unauthenticated' | 'error'> }`
- `apps/daemon/src/connectors/slack/slack.ts`: `export interface SlackConnector { status(): Promise<'ok' | 'unauthenticated' | 'error'> }`
- `apps/daemon/src/remote/away.ts`: `export interface AwayService { isAway(): boolean }`
- `apps/daemon/src/services/remote/session-actions.ts`: `export interface SessionActions { readonly kind: 'session-actions' }`
- `apps/daemon/src/services/secrets/secret-store.ts`: `export interface SecretStore { get(key: string): Promise<string | null> }`
- `apps/daemon/src/services/share/share.ts`: `export interface ShareService { readonly kind: 'share' }`

- [ ] **Step 8: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green, including the 7 new contract tests.

```bash
git add packages/api-contract apps/daemon/src
git commit -m "feat(contract): add phase 6 config, schemas, client methods and bus events"
```

---

### Task 3: Phase 6 tables, repositories and test fakes

**Files:**
- Create: `apps/daemon/src/db/schema-p6.ts`
- Modify: `apps/daemon/src/db/schema.ts` (re-export)
- Create (generated): `apps/daemon/src/db/migrations/<n>_phase6.sql`
- Create: `apps/daemon/src/db/repos/connectors.ts`, `apps/daemon/src/db/repos/remote.ts`, `apps/daemon/src/db/repos/slack-threads.ts`, `apps/daemon/src/db/repos/p6-repos.test.ts`
- Create: `apps/daemon/src/services/audit/actor-scope.ts`
- Modify: `apps/daemon/src/pty/audited-pty.ts`
- Create: `apps/daemon/test/p6-fakes.ts`, `apps/daemon/test/p6-fakes.test.ts`

**Interfaces:**
- Consumes: `OrcDb` and `openDb` (P1); `withPtyInputAudit` (P3); `createTestContext` and `useTempHomes` (P1); `InboxEngine`, `Notifier`, `PtyManager`, `SessionService` (§11).
- Produces:
  ```ts
  // db/repos/connectors.ts
  export type ConnectorKey = 'linear' | 'slack';
  export type ConnectorAuthKind = 'api_key' | 'oauth' | 'user_token';
  export type ConnectorHealth = 'ok' | 'unauthenticated' | 'error';
  export interface ConnectorMeta { connector: ConnectorKey; authKind: ConnectorAuthKind; accountId: string | null; accountLabel: string | null; scopes: string[]; cursor: Record<string, unknown>; lastStatus: ConnectorHealth; connectedAt: string; lastCheckedAt: string | null }
  export function getConnectorMeta(db: OrcDb, connector: ConnectorKey): ConnectorMeta | null
  export function upsertConnectorMeta(db: OrcDb, m: { connector: ConnectorKey; authKind: ConnectorAuthKind; accountId: string | null; accountLabel: string | null; scopes: string[]; connectedAt: string; cursor?: Record<string, unknown> }): ConnectorMeta
  export function setConnectorCursor(db: OrcDb, connector: ConnectorKey, cursor: Record<string, unknown>): void
  export function setConnectorStatus(db: OrcDb, connector: ConnectorKey, status: ConnectorHealth, at: string): void
  export function deleteConnectorMeta(db: OrcDb, connector: ConnectorKey): void
  // db/repos/remote.ts
  export interface RemoteDeviceRow { id: string; name: string; tokenHash: string; login: string | null; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }
  export function insertRemoteDevice(db: OrcDb, d: RemoteDeviceRow): void
  export function getRemoteDevice(db: OrcDb, id: string): RemoteDeviceRow | null
  export function getRemoteDeviceByTokenHash(db: OrcDb, tokenHash: string): RemoteDeviceRow | null
  export function listRemoteDevices(db: OrcDb): RemoteDeviceRow[]
  export function touchRemoteDevice(db: OrcDb, id: string, at: string): void
  export function revokeRemoteDevice(db: OrcDb, id: string, at: string): boolean      // also deletes its credentials and push subscriptions
  export interface StoredCredential { id: string; deviceId: string; publicKey: string; counter: number; transports: string[]; createdAt: string; lastUsedAt: string | null }
  export function insertWebauthnCredential(db: OrcDb, c: StoredCredential): void
  export function listWebauthnCredentials(db: OrcDb, deviceId: string): StoredCredential[]
  export function getWebauthnCredential(db: OrcDb, id: string): StoredCredential | null
  export function updateWebauthnCounter(db: OrcDb, id: string, counter: number, at: string): void
  export interface StoredPushSubscription { id: string; deviceId: string | null; endpoint: string; p256dh: string; auth: string; createdAt: string; lastOkAt: string | null; failures: number }
  export function upsertPushSubscription(db: OrcDb, s: { deviceId: string | null; endpoint: string; p256dh: string; auth: string; createdAt: string }): StoredPushSubscription
  export function listPushSubscriptions(db: OrcDb): StoredPushSubscription[]
  export function deletePushSubscription(db: OrcDb, endpoint: string): boolean
  export function markPushOk(db: OrcDb, endpoint: string, at: string): void
  export function markPushFailure(db: OrcDb, endpoint: string): number                 // returns the new failure count
  // db/repos/slack-threads.ts
  export interface SlackThread { inboxItemId: string; sessionPk: string | null; channel: string; rootTs: string; lastSeenTs: string; appTs: string[]; reactionsDone: string[]; state: 'open' | 'resolved'; createdAt: string; updatedAt: string }
  export function insertSlackThread(db: OrcDb, t: SlackThread): void
  export function getSlackThread(db: OrcDb, inboxItemId: string): SlackThread | null
  export function listOpenSlackThreads(db: OrcDb): SlackThread[]
  export function updateSlackThread(db: OrcDb, inboxItemId: string, patch: Partial<Pick<SlackThread, 'lastSeenTs' | 'appTs' | 'reactionsDone' | 'state'>>, at: string): void
  // services/audit/actor-scope.ts
  export const actorScope: AsyncLocalStorage<{ actor: AuditActor; actorDetail: string | null }>
  // test/p6-fakes.ts
  export const T0: string
  export function makeP6Session(o: Partial<Session> & { id: string }): Session
  export function ownedLive(ptyId?: string): LiveState
  export function makeInboxItem(o: Partial<InboxItem> & { id: string }): InboxItem
  export function fakePty(): PtyManager & { sent: Array<{ id: string; text: string }> }
  export function fakeSessions(list: Session[]): SessionService
  export function fakeInbox(bus: EventBus, items?: InboxItem[]): InboxEngineRuntime & { items: InboxItem[] }
  export function fakeNotifier(): Notifier & { channels: NotifyChannelImpl[]; notified: InboxItem[] }
  export function p6Context(o?: { sessions?: Session[]; inbox?: InboxItem[]; config?: Record<string, unknown> }): { ctx: ReturnType<typeof createTestContext>; rawPty: ReturnType<typeof fakePty>; audit: AuditService; inbox: ReturnType<typeof fakeInbox>; notifier: ReturnType<typeof fakeNotifier> }
  export function withRemote(app: OrcApp): OrcApp   // test middleware: header x-test-remote: "<deviceId>" sets c.var.remote
  ```

- [ ] **Step 1: Write the failing repository test**

`apps/daemon/src/db/repos/p6-repos.test.ts`
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrcDb, openDb } from '../client.ts';
import {
  deleteConnectorMeta,
  getConnectorMeta,
  setConnectorCursor,
  setConnectorStatus,
  upsertConnectorMeta,
} from './connectors.ts';
import {
  deletePushSubscription,
  getRemoteDeviceByTokenHash,
  getWebauthnCredential,
  insertRemoteDevice,
  insertWebauthnCredential,
  listPushSubscriptions,
  listRemoteDevices,
  listWebauthnCredentials,
  markPushFailure,
  revokeRemoteDevice,
  updateWebauthnCounter,
  upsertPushSubscription,
} from './remote.ts';
import { getSlackThread, insertSlackThread, listOpenSlackThreads, updateSlackThread } from './slack-threads.ts';

const T = '2026-09-17T10:00:00.000Z';
let dir: string;
let db: OrcDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p6-repos-'));
  const opened = openDb(join(dir, 'index.db'));
  db = opened.db;
  close = opened.close;
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('connector meta', () => {
  it('upserts, updates cursor and status, and deletes', () => {
    const m = upsertConnectorMeta(db, {
      connector: 'slack', authKind: 'user_token', accountId: 'U1', accountLabel: 'me @ acme',
      scopes: ['chat:write'], connectedAt: T,
    });
    expect(m).toMatchObject({ connector: 'slack', cursor: {}, lastStatus: 'ok', lastCheckedAt: null });
    setConnectorCursor(db, 'slack', { mentionsSinceTs: '1.000001' });
    setConnectorStatus(db, 'slack', 'error', T);
    expect(getConnectorMeta(db, 'slack')).toMatchObject({ cursor: { mentionsSinceTs: '1.000001' }, lastStatus: 'error', lastCheckedAt: T });
    upsertConnectorMeta(db, { connector: 'slack', authKind: 'oauth', accountId: 'U1', accountLabel: null, scopes: [], connectedAt: T });
    expect(getConnectorMeta(db, 'slack')).toMatchObject({ authKind: 'oauth', cursor: {}, lastStatus: 'ok' });
    deleteConnectorMeta(db, 'slack');
    expect(getConnectorMeta(db, 'slack')).toBeNull();
  });
});

describe('remote devices, credentials and push subscriptions', () => {
  it('stores hashed devices and revokes them with their credentials and subscriptions', () => {
    insertRemoteDevice(db, { id: 'd1', name: 'Phone', tokenHash: 'h1', login: 'me@example.com', createdAt: T, lastSeenAt: null, revokedAt: null });
    insertWebauthnCredential(db, { id: 'c1', deviceId: 'd1', publicKey: 'AQID', counter: 0, transports: ['internal'], createdAt: T, lastUsedAt: null });
    upsertPushSubscription(db, { deviceId: 'd1', endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', createdAt: T });
    expect(getRemoteDeviceByTokenHash(db, 'h1')?.id).toBe('d1');
    updateWebauthnCounter(db, 'c1', 5, T);
    expect(getWebauthnCredential(db, 'c1')).toMatchObject({ counter: 5, lastUsedAt: T, transports: ['internal'] });
    expect(revokeRemoteDevice(db, 'd1', T)).toBe(true);
    expect(listRemoteDevices(db)[0]?.revokedAt).toBe(T);
    expect(listWebauthnCredentials(db, 'd1')).toEqual([]);
    expect(listPushSubscriptions(db)).toEqual([]);
    expect(revokeRemoteDevice(db, 'missing', T)).toBe(false);
  });

  it('upserts push subscriptions by endpoint and counts failures', () => {
    const a = upsertPushSubscription(db, { deviceId: null, endpoint: 'https://e/1', p256dh: 'p1', auth: 'a1', createdAt: T });
    const b = upsertPushSubscription(db, { deviceId: null, endpoint: 'https://e/1', p256dh: 'p2', auth: 'a2', createdAt: T });
    expect(b.id).toBe(a.id);
    expect(b.p256dh).toBe('p2');
    expect(markPushFailure(db, 'https://e/1')).toBe(1);
    expect(markPushFailure(db, 'https://e/1')).toBe(2);
    expect(deletePushSubscription(db, 'https://e/1')).toBe(true);
    expect(deletePushSubscription(db, 'https://e/1')).toBe(false);
  });
});

describe('slack threads', () => {
  it('inserts, lists open threads and patches them', () => {
    insertSlackThread(db, {
      inboxItemId: 'i1', sessionPk: 'claude:s1', channel: 'D1', rootTs: '10.000100', lastSeenTs: '10.000100',
      appTs: ['10.000100'], reactionsDone: [], state: 'open', createdAt: T, updatedAt: T,
    });
    expect(listOpenSlackThreads(db).map((t) => t.inboxItemId)).toEqual(['i1']);
    updateSlackThread(db, 'i1', { lastSeenTs: '11.000000', appTs: ['10.000100', '11.000000'], reactionsDone: ['zzz'] }, T);
    expect(getSlackThread(db, 'i1')).toMatchObject({ lastSeenTs: '11.000000', reactionsDone: ['zzz'], appTs: ['10.000100', '11.000000'] });
    updateSlackThread(db, 'i1', { state: 'resolved' }, T);
    expect(listOpenSlackThreads(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/db/repos/p6-repos.test.ts`
Expected: FAIL, `Cannot find module './connectors.ts'`

- [ ] **Step 3: Write the schema and generate the migration**

`apps/daemon/src/db/schema-p6.ts`
```ts
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Non-secret metadata only. Tokens live in the Keychain (SecretStore).
export const connectorTokensMeta = sqliteTable('connector_tokens_meta', {
  connector: text('connector').primaryKey(),
  authKind: text('auth_kind').notNull(),
  accountId: text('account_id'),
  accountLabel: text('account_label'),
  scopesJson: text('scopes_json').notNull().default('[]'),
  cursorJson: text('cursor_json').notNull().default('{}'),
  lastStatus: text('last_status').notNull().default('ok'),
  connectedAt: text('connected_at').notNull(),
  lastCheckedAt: text('last_checked_at'),
});

export const remoteDevices = sqliteTable('remote_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  login: text('login'),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
});

export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => remoteDevices.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transportsJson: text('transports_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('webauthn_credentials_device_idx').on(t.deviceId)],
);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').references(() => remoteDevices.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: text('created_at').notNull(),
  lastOkAt: text('last_ok_at'),
  failures: integer('failures').notNull().default(0),
});

export const slackThreads = sqliteTable(
  'slack_threads',
  {
    inboxItemId: text('inbox_item_id').primaryKey(),
    sessionPk: text('session_pk'),
    channel: text('channel').notNull(),
    rootTs: text('root_ts').notNull(),
    lastSeenTs: text('last_seen_ts').notNull(),
    appTsJson: text('app_ts_json').notNull().default('[]'),
    reactionsDoneJson: text('reactions_done_json').notNull().default('[]'),
    state: text('state').notNull().default('open'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('slack_threads_state_idx').on(t.state)],
);
```

Append to `apps/daemon/src/db/schema.ts`:
```ts
export * from './schema-p6.ts';
```

Run: `pnpm --filter @orc/daemon db:generate`
Expected: a new SQL file in `apps/daemon/src/db/migrations/` that creates the five tables.

- [ ] **Step 4: Write the repositories**

`apps/daemon/src/db/repos/connectors.ts`
```ts
import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { connectorTokensMeta } from '../schema-p6.ts';

export type ConnectorKey = 'linear' | 'slack';
export type ConnectorAuthKind = 'api_key' | 'oauth' | 'user_token';
export type ConnectorHealth = 'ok' | 'unauthenticated' | 'error';

export interface ConnectorMeta {
  connector: ConnectorKey;
  authKind: ConnectorAuthKind;
  accountId: string | null;
  accountLabel: string | null;
  scopes: string[];
  cursor: Record<string, unknown>;
  lastStatus: ConnectorHealth;
  connectedAt: string;
  lastCheckedAt: string | null;
}

type Row = typeof connectorTokensMeta.$inferSelect;

function toMeta(r: Row): ConnectorMeta {
  return {
    connector: r.connector as ConnectorKey,
    authKind: r.authKind as ConnectorAuthKind,
    accountId: r.accountId,
    accountLabel: r.accountLabel,
    scopes: JSON.parse(r.scopesJson) as string[],
    cursor: JSON.parse(r.cursorJson) as Record<string, unknown>,
    lastStatus: r.lastStatus as ConnectorHealth,
    connectedAt: r.connectedAt,
    lastCheckedAt: r.lastCheckedAt,
  };
}

export function getConnectorMeta(db: OrcDb, connector: ConnectorKey): ConnectorMeta | null {
  const r = db.select().from(connectorTokensMeta).where(eq(connectorTokensMeta.connector, connector)).get();
  return r ? toMeta(r) : null;
}

export function upsertConnectorMeta(
  db: OrcDb,
  m: {
    connector: ConnectorKey;
    authKind: ConnectorAuthKind;
    accountId: string | null;
    accountLabel: string | null;
    scopes: string[];
    connectedAt: string;
    cursor?: Record<string, unknown>;
  },
): ConnectorMeta {
  const values = {
    connector: m.connector,
    authKind: m.authKind,
    accountId: m.accountId,
    accountLabel: m.accountLabel,
    scopesJson: JSON.stringify(m.scopes),
    cursorJson: JSON.stringify(m.cursor ?? {}),
    lastStatus: 'ok',
    connectedAt: m.connectedAt,
    lastCheckedAt: null,
  };
  db.insert(connectorTokensMeta)
    .values(values)
    .onConflictDoUpdate({
      target: connectorTokensMeta.connector,
      set: {
        authKind: values.authKind,
        accountId: values.accountId,
        accountLabel: values.accountLabel,
        scopesJson: values.scopesJson,
        cursorJson: values.cursorJson,
        lastStatus: values.lastStatus,
        connectedAt: values.connectedAt,
        lastCheckedAt: null,
      },
    })
    .run();
  const saved = getConnectorMeta(db, m.connector);
  if (!saved) throw new Error(`connector meta ${m.connector} was not saved`);
  return saved;
}

export function setConnectorCursor(db: OrcDb, connector: ConnectorKey, cursor: Record<string, unknown>): void {
  db.update(connectorTokensMeta)
    .set({ cursorJson: JSON.stringify(cursor) })
    .where(eq(connectorTokensMeta.connector, connector))
    .run();
}

export function setConnectorStatus(db: OrcDb, connector: ConnectorKey, status: ConnectorHealth, at: string): void {
  db.update(connectorTokensMeta)
    .set({ lastStatus: status, lastCheckedAt: at })
    .where(eq(connectorTokensMeta.connector, connector))
    .run();
}

export function deleteConnectorMeta(db: OrcDb, connector: ConnectorKey): void {
  db.delete(connectorTokensMeta).where(eq(connectorTokensMeta.connector, connector)).run();
}
```

`apps/daemon/src/db/repos/remote.ts`
```ts
import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { pushSubscriptions, remoteDevices, webauthnCredentials } from '../schema-p6.ts';

export interface RemoteDeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  login: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export function insertRemoteDevice(db: OrcDb, d: RemoteDeviceRow): void {
  db.insert(remoteDevices).values(d).run();
}

export function getRemoteDevice(db: OrcDb, id: string): RemoteDeviceRow | null {
  return db.select().from(remoteDevices).where(eq(remoteDevices.id, id)).get() ?? null;
}

export function getRemoteDeviceByTokenHash(db: OrcDb, tokenHash: string): RemoteDeviceRow | null {
  return db.select().from(remoteDevices).where(eq(remoteDevices.tokenHash, tokenHash)).get() ?? null;
}

export function listRemoteDevices(db: OrcDb): RemoteDeviceRow[] {
  return db.select().from(remoteDevices).orderBy(desc(remoteDevices.createdAt)).all();
}

export function touchRemoteDevice(db: OrcDb, id: string, at: string): void {
  db.update(remoteDevices).set({ lastSeenAt: at }).where(eq(remoteDevices.id, id)).run();
}

export function revokeRemoteDevice(db: OrcDb, id: string, at: string): boolean {
  const res = db.update(remoteDevices).set({ revokedAt: at }).where(eq(remoteDevices.id, id)).run();
  if (res.changes === 0) return false;
  db.delete(webauthnCredentials).where(eq(webauthnCredentials.deviceId, id)).run();
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, id)).run();
  return true;
}

export interface StoredCredential {
  id: string;
  deviceId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

type CredRow = typeof webauthnCredentials.$inferSelect;
const toCred = (r: CredRow): StoredCredential => ({
  id: r.id,
  deviceId: r.deviceId,
  publicKey: r.publicKey,
  counter: r.counter,
  transports: JSON.parse(r.transportsJson) as string[],
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

export function insertWebauthnCredential(db: OrcDb, c: StoredCredential): void {
  db.insert(webauthnCredentials)
    .values({
      id: c.id,
      deviceId: c.deviceId,
      publicKey: c.publicKey,
      counter: c.counter,
      transportsJson: JSON.stringify(c.transports),
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    })
    .run();
}

export function listWebauthnCredentials(db: OrcDb, deviceId: string): StoredCredential[] {
  return db.select().from(webauthnCredentials).where(eq(webauthnCredentials.deviceId, deviceId)).all().map(toCred);
}

export function getWebauthnCredential(db: OrcDb, id: string): StoredCredential | null {
  const r = db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, id)).get();
  return r ? toCred(r) : null;
}

export function updateWebauthnCounter(db: OrcDb, id: string, counter: number, at: string): void {
  db.update(webauthnCredentials).set({ counter, lastUsedAt: at }).where(eq(webauthnCredentials.id, id)).run();
}

export interface StoredPushSubscription {
  id: string;
  deviceId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
}

export function upsertPushSubscription(
  db: OrcDb,
  s: { deviceId: string | null; endpoint: string; p256dh: string; auth: string; createdAt: string },
): StoredPushSubscription {
  db.insert(pushSubscriptions)
    .values({ id: randomUUID(), ...s, failures: 0 })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { deviceId: s.deviceId, p256dh: s.p256dh, auth: s.auth, failures: 0 },
    })
    .run();
  const row = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint)).get();
  if (!row) throw new Error('push subscription was not saved');
  return row;
}

export function listPushSubscriptions(db: OrcDb): StoredPushSubscription[] {
  return db.select().from(pushSubscriptions).all();
}

export function deletePushSubscription(db: OrcDb, endpoint: string): boolean {
  return db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run().changes > 0;
}

export function markPushOk(db: OrcDb, endpoint: string, at: string): void {
  db.update(pushSubscriptions).set({ lastOkAt: at, failures: 0 }).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

export function markPushFailure(db: OrcDb, endpoint: string): number {
  db.update(pushSubscriptions)
    .set({ failures: sql`${pushSubscriptions.failures} + 1` })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get()?.failures ?? 0;
}
```

`apps/daemon/src/db/repos/slack-threads.ts`
```ts
import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { slackThreads } from '../schema-p6.ts';

export interface SlackThread {
  inboxItemId: string;
  sessionPk: string | null;
  channel: string;
  rootTs: string;
  lastSeenTs: string;
  appTs: string[];
  reactionsDone: string[];
  state: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

type Row = typeof slackThreads.$inferSelect;
const toThread = (r: Row): SlackThread => ({
  inboxItemId: r.inboxItemId,
  sessionPk: r.sessionPk,
  channel: r.channel,
  rootTs: r.rootTs,
  lastSeenTs: r.lastSeenTs,
  appTs: JSON.parse(r.appTsJson) as string[],
  reactionsDone: JSON.parse(r.reactionsDoneJson) as string[],
  state: r.state as SlackThread['state'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function insertSlackThread(db: OrcDb, t: SlackThread): void {
  db.insert(slackThreads)
    .values({
      inboxItemId: t.inboxItemId,
      sessionPk: t.sessionPk,
      channel: t.channel,
      rootTs: t.rootTs,
      lastSeenTs: t.lastSeenTs,
      appTsJson: JSON.stringify(t.appTs),
      reactionsDoneJson: JSON.stringify(t.reactionsDone),
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .run();
}

export function getSlackThread(db: OrcDb, inboxItemId: string): SlackThread | null {
  const r = db.select().from(slackThreads).where(eq(slackThreads.inboxItemId, inboxItemId)).get();
  return r ? toThread(r) : null;
}

export function listOpenSlackThreads(db: OrcDb): SlackThread[] {
  return db.select().from(slackThreads).where(eq(slackThreads.state, 'open')).all().map(toThread);
}

export function updateSlackThread(
  db: OrcDb,
  inboxItemId: string,
  patch: Partial<Pick<SlackThread, 'lastSeenTs' | 'appTs' | 'reactionsDone' | 'state'>>,
  at: string,
): void {
  const set: Partial<typeof slackThreads.$inferInsert> = { updatedAt: at };
  if (patch.lastSeenTs !== undefined) set.lastSeenTs = patch.lastSeenTs;
  if (patch.appTs !== undefined) set.appTsJson = JSON.stringify(patch.appTs);
  if (patch.reactionsDone !== undefined) set.reactionsDoneJson = JSON.stringify(patch.reactionsDone);
  if (patch.state !== undefined) set.state = patch.state;
  db.update(slackThreads).set(set).where(eq(slackThreads.inboxItemId, inboxItemId)).run();
}
```

Run: `pnpm vitest run apps/daemon/src/db/repos/p6-repos.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the audit actor scope**

This lets remote replies be audited as `actor: 'remote'` by P3's PTY wrapper.

`apps/daemon/src/services/audit/actor-scope.ts`
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActor } from '@orc/core';

/** Run code inside `actorScope.run({ actor, actorDetail }, fn)` so audited wrappers attribute it correctly. */
export const actorScope = new AsyncLocalStorage<{ actor: AuditActor; actorDetail: string | null }>();
```

In `apps/daemon/src/pty/audited-pty.ts`, make two changes:
1. Add `import { actorScope } from '../services/audit/actor-scope.ts';`.
2. Replace the `sendText` member with:
```ts
    sendText(id, text) {
      const who = actorScope.getStore() ?? { actor, actorDetail: null };
      return audited(
        audit,
        {
          actor: who.actor,
          actorDetail: who.actorDetail,
          action: 'pty.input',
          target: targetOf(id),
          params: { via: 'paste', ptyId: id, bytes: text.length, text: redact(text).slice(0, PREVIEW) },
        },
        () => pty.sendText(id, text),
      );
    },
```

- [ ] **Step 6: Write the shared test fakes and their smoke test**

`apps/daemon/test/p6-fakes.ts`
```ts
import { randomUUID } from 'node:crypto';
import { OrcConfig } from '@orc/api-contract';
import { type InboxItem, type LiveState, type Session, emptyUsage } from '@orc/core';
import type { InboxEngineRuntime } from '../src/inbox/engine.ts';
import type { EventBus } from '../src/live/event-bus.ts';
import type { Notifier, NotifyChannelImpl } from '../src/notify/notifier.ts';
import { withPtyInputAudit } from '../src/pty/audited-pty.ts';
import type { PtyInfo, PtyManager } from '../src/pty/pty-manager.ts';
import type { AuditService } from '../src/services/audit/audit.ts';
import { type SessionService, sessionPk } from '../src/services/sessions.ts';
import type { OrcApp } from '../src/http/types.ts';
import { createTestContext } from './helpers.ts';

export const T0 = '2026-09-17T09:00:00.000Z';

export function makeP6Session(o: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: 'Test session',
    firstPrompt: 'check the tests',
    lastPrompt: 'continue?',
    awaySummary: null,
    recap: null,
    startedAt: T0,
    lastActivityAt: T0,
    models: ['claude-opus-5'],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: ['SAF-1787'],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 1,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: null,
    lastTest: null,
    live: null,
    ...o,
  };
}

export function ownedLive(ptyId = 'pty-1'): LiveState {
  return {
    pid: 4242, status: 'waiting', waitingFor: 'Proceed?', since: T0, ownership: 'owned', ptyId,
    stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
  };
}

export function makeInboxItem(o: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    kind: 'waiting',
    sessionId: 's1',
    projectId: 'wakecap',
    ticket: 'SAF-1787',
    reason: 'Waiting for input: Proceed?',
    dedupeKey: 'waiting:claude:s1',
    createdAt: T0,
    updatedAt: T0,
    state: 'open',
    snoozeUntil: null,
    payload: { source: 'claude', id: 's1' },
    ...o,
  };
}

export function fakePty(): PtyManager & { sent: Array<{ id: string; text: string }> } {
  const sent: Array<{ id: string; text: string }> = [];
  const info = (id: string): PtyInfo => ({
    id, sessionPk: null, command: 'claude', args: [], cwd: '/Users/test/Wakecap', pid: 1,
    startedAt: T0, exitedAt: null, exitCode: null, cols: 120, rows: 40,
  });
  return {
    sent,
    spawn: (o) => ({ ...info('pty-new'), command: o.command, args: o.args, cwd: o.cwd }),
    write: () => {},
    sendText: async (id, text) => {
      sent.push({ id, text });
    },
    resize: () => {},
    kill: () => {},
    attach: () => ({ scrollback: '', detach: () => {} }),
    list: () => [],
    get: (id) => info(id),
    remove: () => {},
    disposeAll: () => {},
  };
}

export function fakeSessions(list: Session[]): SessionService {
  const byPk = (pk: string) => list.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    list: () => ({ items: [], nextCursor: null }),
    get: (source, id) => list.find((s) => s.source === source && s.id === id) ?? null,
    getByPk: byPk,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive: (pk, live) => {
      const s = byPk(pk);
      if (s) s.live = live;
    },
    resume: async () => ({ ptyId: 'pty-resumed' }),
  };
}

export function fakeInbox(bus: EventBus, items: InboxItem[] = []): InboxEngineRuntime & { items: InboxItem[] } {
  const set = (id: string, patch: Partial<InboxItem>): InboxItem => {
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`no inbox item ${id}`);
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    bus.emit({ type: 'inbox.upserted', item: it });
    return it;
  };
  return {
    items,
    upsert: (u) => {
      const now = new Date().toISOString();
      const it: InboxItem = {
        id: randomUUID(), kind: u.kind, sessionId: u.sessionId ?? null, projectId: u.projectId ?? null,
        ticket: u.ticket ?? null, reason: u.reason, dedupeKey: u.dedupeKey, createdAt: now, updatedAt: now,
        state: 'open', snoozeUntil: null, payload: u.payload ?? {},
      };
      items.push(it);
      bus.emit({ type: 'inbox.upserted', item: it });
      return it;
    },
    resolve: (key) => {
      const it = items.find((i) => i.dedupeKey === key && (i.state === 'open' || i.state === 'snoozed'));
      if (it) set(it.id, { state: 'auto_resolved' });
    },
    list: (f) =>
      items.filter(
        (i) =>
          (!f.state || f.state.includes(i.state)) &&
          (!f.kind || f.kind.includes(i.kind)) &&
          (!f.projectId || i.projectId === f.projectId),
      ),
    markDone: (id) => set(id, { state: 'done' }),
    snooze: (id, until) => set(id, { state: 'snoozed', snoozeUntil: until }),
    reopen: (id) => set(id, { state: 'open', snoozeUntil: null }),
    registerRule: () => {},
    tick: () => {},
    start: () => {},
    stop: () => {},
  };
}

export function fakeNotifier(): Notifier & { channels: NotifyChannelImpl[]; notified: InboxItem[] } {
  const channels: NotifyChannelImpl[] = [];
  const notified: InboxItem[] = [];
  let away = false;
  return {
    channels,
    notified,
    notify: async (i) => {
      notified.push(i);
    },
    register: (c) => {
      channels.push(c);
    },
    setAway: (a) => {
      away = a;
    },
    isAway: () => away,
  };
}

export function p6Context(o: { sessions?: Session[]; inbox?: InboxItem[]; config?: Record<string, unknown> } = {}) {
  const ctx = createTestContext();
  let cfg = OrcConfig.parse(o.config ?? {});
  const audit = ctx.audit;
  if (!audit) throw new Error('P3 createTestContext must set ctx.audit');
  const rawPty = fakePty();
  const inbox = fakeInbox(ctx.bus, o.inbox ?? []);
  const notifier = fakeNotifier();
  ctx.config = () => cfg;
  ctx.updateConfig = (fn) => {
    cfg = OrcConfig.parse(fn(cfg));
    return cfg;
  };
  ctx.pty = withPtyInputAudit(rawPty, audit);
  ctx.sessions = fakeSessions(o.sessions ?? []);
  ctx.inbox = inbox;
  ctx.notifier = notifier;
  ctx.denyList = {
    check: (text: string) =>
      /terraform apply|rm -rf|git push --force/i.test(text)
        ? { denied: true, reason: 'matches the deny-list' }
        : { denied: false, reason: null },
  };
  ctx.plans = undefined; // tests that need P4 plan approval set it explicitly
  return { ctx, rawPty, audit: audit as AuditService, inbox, notifier };
}

/** Test-only middleware: `x-test-remote: <deviceId>` marks the request as coming from a paired remote device. */
export function withRemote(app: OrcApp): OrcApp {
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-remote');
    c.set('remote', id ? { deviceId: id, deviceName: 'Test phone', login: 'me@example.com' } : null);
    await next();
  });
  return app;
}
```

`apps/daemon/test/p6-fakes.test.ts`
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { actorScope } from '../src/services/audit/actor-scope.ts';
import { useTempHomes } from './helpers.ts';
import { makeInboxItem, p6Context } from './p6-fakes.ts';

describe('p6 fakes', () => {
  useTempHomes();
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  it('audits pty input with the actor from actorScope', async () => {
    const { ctx, rawPty, audit } = p6Context();
    disposers.push(() => ctx.dispose());
    await actorScope.run({ actor: 'remote', actorDetail: 'Phone (me@example.com)' }, () => ctx.pty.sendText('pty-1', 'yes'));
    await ctx.pty.sendText('pty-1', 'local');
    expect(rawPty.sent.map((s) => s.text)).toEqual(['yes', 'local']);
    const entries = audit.list({ action: 'pty.input' });
    expect(entries.map((e) => e.actor).sort()).toEqual(['remote', 'user']);
    expect(entries.find((e) => e.actor === 'remote')?.actorDetail).toBe('Phone (me@example.com)');
  });

  it('emits inbox.upserted on state changes', () => {
    const { ctx, inbox } = p6Context({ inbox: [makeInboxItem({ id: 'i1' })] });
    disposers.push(() => ctx.dispose());
    const seen: string[] = [];
    ctx.bus.on('inbox.upserted', (e) => seen.push(e.item.state));
    inbox.markDone('i1');
    expect(seen).toEqual(['done']);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p6-fakes.test.ts apps/daemon/src/pty`
Expected: PASS. P3's own `audited-pty` tests still pass, because the default actor is unchanged when there is no scope.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add phase 6 tables, repositories, actor scope and test fakes"
```

---

### Task 4: SecretStore (macOS Keychain via `@napi-rs/keyring`)

**Files:**
- Create: `apps/daemon/src/services/secrets/secret-store.ts` (replaces the Task 2 stub), `apps/daemon/src/services/secrets/secret-store.test.ts`
- Modify: `apps/daemon/package.json` (`@napi-rs/keyring`)

**Interfaces:**
- Consumes: `AsyncEntry` from `@napi-rs/keyring@^2.1.0`, which has this shape (checked against the package's `index.d.ts`):
  ```ts
  new AsyncEntry(service, username)
  getPassword(): Promise<string | undefined>
  setPassword(p): Promise<void>
  deleteCredential(): Promise<boolean>
  ```
- Produces:
  ```ts
  export const SECRET_SERVICE = 'orchestrator';
  export type SecretKey = `${'linear' | 'slack'}.${'token' | 'client_id' | 'client_secret' | 'refresh_token'}`;
  export interface SecretStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
  export function createSecretStore(service?: string): SecretStore
  export function createMemorySecretStore(initial?: Record<string, string>): SecretStore & { dump(): Record<string, string> }
  ```
  Keys must match `^[a-z]+\.[a-z_]+$`. Values must not be empty. `get()` returns `null` when the entry doesn't exist.

- [ ] **Step 1: Install the dependency**

Run: `pnpm --filter @orc/daemon add @napi-rs/keyring@^2.1.0`
Expected: installs without a build step (it ships prebuilt binaries).

- [ ] **Step 2: Write the failing test**

`apps/daemon/src/services/secrets/secret-store.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, createSecretStore } from './secret-store.ts';

describe('memory secret store', () => {
  it('gets, sets and deletes', async () => {
    const s = createMemorySecretStore({ 'slack.token': 'xoxp-1' });
    expect(await s.get('slack.token')).toBe('xoxp-1');
    await s.set('linear.token', 'lin_api_2');
    expect(s.dump()).toEqual({ 'slack.token': 'xoxp-1', 'linear.token': 'lin_api_2' });
    await s.delete('slack.token');
    await s.delete('slack.token');
    expect(await s.get('slack.token')).toBeNull();
  });

  it('rejects malformed keys and empty values', async () => {
    const s = createMemorySecretStore();
    await expect(s.get('../etc')).rejects.toThrow('invalid secret key');
    await expect(s.set('slack.token', '')).rejects.toThrow('empty secret');
  });
});

describe.skipIf(process.env.ORC_TEST_KEYCHAIN !== '1')('keychain secret store (ORC_TEST_KEYCHAIN=1)', () => {
  it('round-trips through the real Keychain under a test service', async () => {
    const s = createSecretStore(`orchestrator-test-${process.pid}`);
    expect(await s.get('slack.token')).toBeNull();
    await s.set('slack.token', 'xoxp-test-value');
    expect(await s.get('slack.token')).toBe('xoxp-test-value');
    await s.delete('slack.token');
    expect(await s.get('slack.token')).toBeNull();
    await s.delete('slack.token');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/secrets`
Expected: FAIL, `createMemorySecretStore is not a function` (the Task 2 stub has no exports)

- [ ] **Step 4: Implement it**

`apps/daemon/src/services/secrets/secret-store.ts`
```ts
import { AsyncEntry } from '@napi-rs/keyring';

export const SECRET_SERVICE = 'orchestrator';
export type SecretKey = `${'linear' | 'slack'}.${'token' | 'client_id' | 'client_secret' | 'refresh_token'}`;

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function assertKey(key: string): void {
  if (!/^[a-z]+\.[a-z_]+$/.test(key)) throw new Error(`invalid secret key: ${key}`);
}

function assertValue(value: string): void {
  if (value.length === 0) throw new Error('empty secret');
}

function isNoEntry(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no (matching )?entry|not found|could not be found/i.test(message);
}

/** macOS Keychain (generic password), service "orchestrator", account = key. */
export function createSecretStore(service: string = SECRET_SERVICE): SecretStore {
  return {
    async get(key) {
      assertKey(key);
      try {
        return (await new AsyncEntry(service, key).getPassword()) ?? null;
      } catch (e) {
        if (isNoEntry(e)) return null;
        throw e;
      }
    },
    async set(key, value) {
      assertKey(key);
      assertValue(value);
      await new AsyncEntry(service, key).setPassword(value);
    },
    async delete(key) {
      assertKey(key);
      try {
        await new AsyncEntry(service, key).deleteCredential();
      } catch (e) {
        if (!isNoEntry(e)) throw e;
      }
    },
  };
}

export function createMemorySecretStore(
  initial: Record<string, string> = {},
): SecretStore & { dump(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) {
      assertKey(key);
      return values.get(key) ?? null;
    },
    async set(key, value) {
      assertKey(key);
      assertValue(value);
      values.set(key, value);
    },
    async delete(key) {
      assertKey(key);
      values.delete(key);
    },
    dump: () => Object.fromEntries(values),
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/secrets`
Expected: PASS (2 tests, 1 skipped)

Then run once by hand on the Mac: `ORC_TEST_KEYCHAIN=1 pnpm vitest run apps/daemon/src/services/secrets`
Expected: PASS (3 tests). macOS may show a Keychain prompt; click **Always Allow**. Paste the output into the review note.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add keychain-backed SecretStore"
```

---

### Task 5: Linear connector (as me) with an injectable API adapter

**Files:**
- Modify: `apps/daemon/package.json` (`@linear/sdk`)
- Create: `apps/daemon/src/connectors/errors.ts`, `apps/daemon/src/connectors/util.ts`
- Create: `apps/daemon/src/connectors/linear/api.ts`, `apps/daemon/src/connectors/linear/linear.ts` (replaces the Task 2 stub), `apps/daemon/src/connectors/linear/linear.test.ts`
- Create: `apps/daemon/test/p6-connector-fakes.ts`

**Interfaces:**
- Consumes:
  - `SecretStore` (Task 4)
  - `LinearIssue` (Task 2)
  - `redact` (core)
  - `ServiceError` (P1)
  - `@linear/sdk@^95.1.0`, with these shapes (checked against `dist/index.d.mts`):
    ```ts
    new LinearClient({ apiKey } | { accessToken })
    client.viewer                                       // LinearFetch<User>
    client.issue(id)                                    // accepts identifiers like "SAF-1787"
    client.teams({ filter: { key: { eq } } })
    client.createComment({ issueId, body })             // → CommentPayload.success
    client.createIssue({ teamId, title, description, assigneeId })   // → IssuePayload.issue
    user.assignedIssues({ first, filter })
    issue.state                                         // LinearFetch<WorkflowState> | undefined
    issue.assignee
    issue.labels()
    // errors carry `type: LinearErrorType` ('AuthenticationError' | 'Forbidden' | 'InvalidInput' | …)
    ```
- Produces:
  ```ts
  // connectors/errors.ts
  export type ConnectorErrorCode = 'unauthenticated' | 'not_found' | 'bad_request' | 'upstream_error';
  export class ConnectorError extends Error { readonly code: ConnectorErrorCode }
  export function toServiceError(e: unknown): unknown        // ConnectorError → ServiceError(code, 401|404|400|502)
  // connectors/util.ts
  export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>
  // connectors/linear/api.ts
  export interface LinearViewer { id: string; name: string; email: string }
  export interface LinearApi { viewer(): Promise<LinearViewer>; issue(identifier: string): Promise<LinearIssue | null>; createComment(issueId: string, body: string): Promise<void>; teamIdByKey(key: string): Promise<string | null>; createIssue(input: { teamId: string; title: string; description: string; assigneeId?: string }): Promise<LinearIssue>; assignedIssues(first: number): Promise<LinearIssue[]> }
  export function createLinearSdkApi(token: string): LinearApi
  // connectors/linear/linear.ts
  export type { LinearIssue }
  export interface LinearConnector   // exactly as in Contract additions §11
  export interface LinearConnectorDeps { secrets: SecretStore; api?: (token: string) => LinearApi; cacheTtlMs?: number; now?: () => number }
  export function toLinearError(e: unknown): ConnectorError
  export function createLinearConnector(d: LinearConnectorDeps): LinearConnector
  // test/p6-connector-fakes.ts
  export function linearIssue(identifier: string, o?: Partial<LinearIssue>): LinearIssue
  export function fakeLinearApi(): LinearApi & { control: { failAuth: boolean }; comments: Array<{ issueId: string; body: string }>; created: Array<{ teamId: string; title: string; description: string; assigneeId?: string }>; issues: Map<string, LinearIssue>; assigned: LinearIssue[]; issueCalls: string[] }
  ```
- Behaviour:
  - The token is read from `linear.token` on every call. A new token resets the caches.
  - `issue()` caches results, including "not found", for `cacheTtlMs` (default 10 min).
  - `comment()` and `createIssue()` redact the title, description and body.
  - `assignedToMe()` returns up to 50 open issues (state type not `completed` or `canceled`).

- [ ] **Step 1: Install and write the fakes**

Run: `pnpm --filter @orc/daemon add @linear/sdk@^95.1.0`

`apps/daemon/test/p6-connector-fakes.ts`
```ts
import type { LinearIssue } from '@orc/api-contract';
import type { LinearApi } from '../src/connectors/linear/api.ts';

export function linearIssue(identifier: string, o: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    state: 'In Progress',
    assignee: 'Test User',
    url: `https://linear.app/example/issue/${identifier}`,
    labels: [],
    ...o,
  };
}

const authError = () => Object.assign(new Error('Authentication required, not authenticated'), { type: 'AuthenticationError' });

export function fakeLinearApi() {
  const control = { failAuth: false };
  const comments: Array<{ issueId: string; body: string }> = [];
  const created: Array<{ teamId: string; title: string; description: string; assigneeId?: string }> = [];
  const issues = new Map<string, LinearIssue>([['SAF-1787', linearIssue('SAF-1787')]]);
  const assigned: LinearIssue[] = [];
  const issueCalls: string[] = [];
  const api: LinearApi = {
    viewer: async () => {
      if (control.failAuth) throw authError();
      return { id: 'user-1', name: 'Test User', email: 'me@example.com' };
    },
    issue: async (identifier) => {
      if (control.failAuth) throw authError();
      issueCalls.push(identifier);
      return issues.get(identifier) ?? null;
    },
    createComment: async (issueId, body) => {
      comments.push({ issueId, body });
    },
    teamIdByKey: async (key) => (key === 'SAF' ? 'team-saf' : null),
    createIssue: async (input) => {
      created.push(input);
      const issue = linearIssue(`SAF-${2000 + created.length}`, {
        title: input.title,
        assignee: input.assigneeId ? 'Test User' : null,
        state: 'Todo',
      });
      issues.set(issue.identifier, issue);
      return issue;
    },
    assignedIssues: async () => assigned,
  };
  return Object.assign(api, { control, comments, created, issues, assigned, issueCalls });
}
```

- [ ] **Step 2: Write the failing connector test**

`apps/daemon/src/connectors/linear/linear.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { fakeLinearApi } from '../../../test/p6-connector-fakes.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { createLinearConnector, toLinearError } from './linear.ts';

function setup(token: string | null = 'lin_api_test_123') {
  const secrets = createMemorySecretStore(token ? { 'linear.token': token } : {});
  const api = fakeLinearApi();
  const tokensSeen: string[] = [];
  let now = 0;
  const linear = createLinearConnector({
    secrets,
    api: (t) => {
      tokensSeen.push(t);
      return api;
    },
    cacheTtlMs: 1000,
    now: () => now,
  });
  return { secrets, api, linear, tokensSeen, advance: (ms: number) => { now += ms; } };
}

describe('LinearConnector', () => {
  it('reports status', async () => {
    expect(await setup(null).linear.status()).toBe('unauthenticated');
    const s = setup();
    expect(await s.linear.status()).toBe('ok');
    s.api.control.failAuth = true;
    s.linear.invalidate();
    expect(await s.linear.status()).toBe('unauthenticated');
  });

  it('caches issue lookups, including misses, for the TTL', async () => {
    const s = setup();
    expect((await s.linear.issue('saf-1787'))?.identifier).toBe('SAF-1787');
    expect(await s.linear.issue('SAF-1787')).not.toBeNull();
    expect(await s.linear.issue('SAF-9')).toBeNull();
    expect(await s.linear.issue('SAF-9')).toBeNull();
    expect(s.api.issueCalls).toEqual(['SAF-1787', 'SAF-9']);
    s.advance(1001);
    await s.linear.issue('SAF-1787');
    expect(s.api.issueCalls).toEqual(['SAF-1787', 'SAF-9', 'SAF-1787']);
  });

  it('redacts comments and fails for unknown issues', async () => {
    const s = setup();
    await s.linear.comment('SAF-1787', 'done; token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rotated');
    expect(s.api.comments).toEqual([{ issueId: 'id-SAF-1787', body: 'done; token «redacted:github» rotated' }]);
    await expect(s.linear.comment('SAF-404', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('creates issues in a team, assigned to me when asked', async () => {
    const s = setup();
    const issue = await s.linear.createIssue({ teamKey: 'SAF', title: 'Follow-up', description: 'password=hunter2', assignToMe: true });
    expect(issue.identifier).toBe('SAF-2001');
    expect(s.api.created).toEqual([
      { teamId: 'team-saf', title: 'Follow-up', description: 'password=«redacted:secret»', assigneeId: 'user-1' },
    ]);
    await expect(s.linear.createIssue({ teamKey: 'NOPE', title: 'x', description: '' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rebuilds the client when the token changes', async () => {
    const s = setup();
    await s.linear.me();
    await s.secrets.set('linear.token', 'lin_api_other_456');
    await s.linear.me();
    expect(s.tokensSeen).toEqual(['lin_api_test_123', 'lin_api_other_456']);
  });

  it('maps SDK errors', () => {
    expect(toLinearError(Object.assign(new Error('x'), { type: 'Forbidden' })).code).toBe('unauthenticated');
    expect(toLinearError(Object.assign(new Error('Entity not found'), { type: 'InvalidInput' })).code).toBe('not_found');
    expect(toLinearError(new Error('socket hang up')).code).toBe('upstream_error');
    const passthrough = new ConnectorError('bad_request', 'x');
    expect(toLinearError(passthrough)).toBe(passthrough);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/connectors/linear`
Expected: FAIL, `Cannot find module '../errors.ts'`

- [ ] **Step 4: Implement the shared connector helpers**

`apps/daemon/src/connectors/errors.ts`
```ts
import { ServiceError } from '../services/errors.ts';

export type ConnectorErrorCode = 'unauthenticated' | 'not_found' | 'bad_request' | 'upstream_error';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

const STATUS = { unauthenticated: 401, not_found: 404, bad_request: 400, upstream_error: 502 } as const;

export function toServiceError(e: unknown): unknown {
  return e instanceof ConnectorError ? new ServiceError(e.code, STATUS[e.code], e.message) : e;
}
```

`apps/daemon/src/connectors/util.ts`
```ts
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Implement the SDK adapter and the connector**

`apps/daemon/src/connectors/linear/api.ts`
```ts
import { type Issue, LinearClient } from '@linear/sdk';
import type { LinearIssue } from '@orc/api-contract';

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export interface LinearApi {
  viewer(): Promise<LinearViewer>;
  issue(identifier: string): Promise<LinearIssue | null>;
  createComment(issueId: string, body: string): Promise<void>;
  teamIdByKey(key: string): Promise<string | null>;
  createIssue(input: { teamId: string; title: string; description: string; assigneeId?: string }): Promise<LinearIssue>;
  assignedIssues(first: number): Promise<LinearIssue[]>;
}

async function toIssue(i: Issue): Promise<LinearIssue> {
  const [state, assignee, labels] = await Promise.all([i.state, i.assignee, i.labels({ first: 20 })]);
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    state: state?.name ?? 'Unknown',
    assignee: assignee?.name ?? null,
    url: i.url,
    labels: labels.nodes.map((l) => l.name),
  };
}

const isNotFound = (e: unknown) => /not found|could not find/i.test(e instanceof Error ? e.message : String(e));

export function createLinearSdkApi(token: string): LinearApi {
  const client = token.startsWith('lin_api_') ? new LinearClient({ apiKey: token }) : new LinearClient({ accessToken: token });
  return {
    async viewer() {
      const v = await client.viewer;
      return { id: v.id, name: v.name, email: v.email };
    },
    async issue(identifier) {
      try {
        return await toIssue(await client.issue(identifier));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async createComment(issueId, body) {
      const r = await client.createComment({ issueId, body });
      if (!r.success) throw new Error('Linear rejected the comment');
    },
    async teamIdByKey(key) {
      const teams = await client.teams({ filter: { key: { eq: key } }, first: 1 });
      return teams.nodes[0]?.id ?? null;
    },
    async createIssue(input) {
      const r = await client.createIssue(input);
      const issue = await r.issue;
      if (!r.success || !issue) throw new Error('Linear did not create the issue');
      return toIssue(issue);
    },
    async assignedIssues(first) {
      const me = await client.viewer;
      const page = await me.assignedIssues({ first, filter: { state: { type: { nin: ['completed', 'canceled'] } } } });
      return Promise.all(page.nodes.map(toIssue));
    },
  };
}
```

`apps/daemon/src/connectors/linear/linear.ts`
```ts
import type { LinearIssue } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { type LinearApi, type LinearViewer, createLinearSdkApi } from './api.ts';

export type { LinearIssue };

export interface LinearConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  issue(identifier: string): Promise<LinearIssue | null>;
  comment(identifier: string, markdown: string): Promise<void>;
  createIssue(i: { teamKey: string; title: string; description: string; assignToMe?: boolean }): Promise<LinearIssue>;
  assignedToMe(): Promise<LinearIssue[]>;
  me(): Promise<LinearViewer>;
  invalidate(): void;
}

export interface LinearConnectorDeps {
  secrets: SecretStore;
  api?: (token: string) => LinearApi;
  cacheTtlMs?: number;
  now?: () => number;
}

export function toLinearError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const type = (e as { type?: unknown } | null)?.type;
  const message = e instanceof Error ? e.message : String(e);
  if (type === 'AuthenticationError' || type === 'Forbidden') return new ConnectorError('unauthenticated', message);
  if (type === 'InvalidInput' && /not found/i.test(message)) return new ConnectorError('not_found', message);
  if (type === 'InvalidInput' || type === 'UserError') return new ConnectorError('bad_request', message);
  return new ConnectorError('upstream_error', message);
}

export function createLinearConnector(d: LinearConnectorDeps): LinearConnector {
  const factory = d.api ?? createLinearSdkApi;
  const ttl = d.cacheTtlMs ?? 10 * 60_000;
  const now = d.now ?? Date.now;
  let current: { token: string; api: LinearApi } | null = null;
  let viewer: LinearViewer | null = null;
  const issues = new Map<string, { at: number; issue: LinearIssue | null }>();

  function reset(): void {
    current = null;
    viewer = null;
    issues.clear();
  }

  async function run<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const token = await d.secrets.get('linear.token');
    if (!token) throw new ConnectorError('unauthenticated', 'Linear is not connected');
    let api: LinearApi;
    if (current !== null && current.token === token) {
      api = current.api;
    } else {
      reset();
      api = factory(token);
      current = { token, api };
    }
    try {
      return await fn(api);
    } catch (e) {
      throw toLinearError(e);
    }
  }

  async function me(): Promise<LinearViewer> {
    return run(async (api) => {
      if (viewer) return viewer;
      const v = await api.viewer();
      viewer = v;
      return v;
    });
  }

  async function issue(identifier: string): Promise<LinearIssue | null> {
    const key = identifier.trim().toUpperCase();
    return run(async (api) => {
      const hit = issues.get(key);
      if (hit && now() - hit.at < ttl) return hit.issue;
      const found = await api.issue(key);
      issues.set(key, { at: now(), issue: found });
      return found;
    });
  }

  return {
    async status() {
      try {
        await me();
        return 'ok';
      } catch (e) {
        return e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
      }
    },
    me,
    issue,
    async comment(identifier, markdown) {
      const found = await issue(identifier);
      if (!found) throw new ConnectorError('not_found', `Linear issue ${identifier} not found`);
      await run((api) => api.createComment(found.id, redact(markdown)));
    },
    async createIssue(i) {
      const viewerId = i.assignToMe ? (await me()).id : undefined;
      return run(async (api) => {
        const teamId = await api.teamIdByKey(i.teamKey);
        if (!teamId) throw new ConnectorError('bad_request', `Linear team ${i.teamKey} not found`);
        const created = await api.createIssue({
          teamId,
          title: redact(i.title),
          description: redact(i.description),
          ...(viewerId ? { assigneeId: viewerId } : {}),
        });
        issues.set(created.identifier, { at: now(), issue: created });
        return created;
      });
    },
    assignedToMe: () => run((api) => api.assignedIssues(50)),
    invalidate: reset,
  };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/connectors/linear`
Expected: PASS (6 tests)

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add Linear connector acting as the user"
```

---

### Task 6: Slack connector (as me, user token) with an injectable API adapter

**Files:**
- Modify: `apps/daemon/package.json` (`@slack/web-api`)
- Create: `apps/daemon/src/connectors/slack/api.ts`, `apps/daemon/src/connectors/slack/text.ts`, `apps/daemon/src/connectors/slack/slack.ts` (replaces the Task 2 stub), `apps/daemon/src/connectors/slack/slack.test.ts`
- Modify: `apps/daemon/test/p6-connector-fakes.ts` (append `fakeSlackApi`)

**Interfaces:**
- Consumes:
  - `SecretStore`, `ConnectorError`, `redact`
  - `@slack/web-api@^8.1.1` `WebClient`, with these shapes (checked against `dist/types`):
    ```ts
    auth.test()                                         // → user_id, user, team
    conversations.open({ users })                       // → channel.id
    chat.postMessage({ channel, text, thread_ts?, unfurl_links, unfurl_media })   // → ts
    conversations.replies({ channel, ts, oldest?, limit })
      // → messages[] with ts, user, text, bot_id, app_id, subtype, reactions[{ name, users }]; the parent message comes first
    search.messages({ query, count, sort: 'timestamp', sort_dir: 'desc' })        // → messages.matches[] with channel.id, ts, text; needs search:read
    reminders.add({ text, time })
    oauth.v2.access({ client_id, client_secret, code, redirect_uri })             // → authed_user.{ id, access_token, scope }
    // platform errors carry data.error ('invalid_auth', 'missing_scope', …)
    ```
- Produces:
  ```ts
  // connectors/slack/text.ts
  export function compareSlackTs(a: string, b: string): number
  export function slackTsFromDate(d: Date): string
  export function decodeSlackText(t: string): string          // &lt; &gt; &amp;
  // connectors/slack/api.ts
  export interface SlackMessage { ts: string; user: string | null; text: string; botId: string | null; appId: string | null; subtype: string | null; reactions: Array<{ name: string; users: string[] }> }
  export interface SlackApi { authTest(): Promise<{ userId: string; user: string; team: string }>; openDm(userId: string): Promise<string>; postMessage(channel: string, text: string, threadTs?: string): Promise<string>; replies(channel: string, threadTs: string, oldest?: string): Promise<SlackMessage[]>; searchMessages(query: string, count: number): Promise<Array<{ channel: string; ts: string; text: string }>>; addReminder(text: string, time: number): Promise<void>; oauthAccess(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{ userToken: string; userId: string; scopes: string[] }> }
  export function createSlackWebApi(token: string | null): SlackApi
  // connectors/slack/slack.ts
  export interface SlackReply; export interface SlackConnector      // exactly as in Contract additions §11
  export interface SlackConnectorDeps { secrets: SecretStore; api?: (token: string | null) => SlackApi; now?: () => number }
  export function toSlackError(e: unknown): ConnectorError
  export function createSlackConnector(d: SlackConnectorDeps): SlackConnector
  // test/p6-connector-fakes.ts (appended)
  export function fakeSlackApi(): SlackApi & { control: { failAuth: boolean }; posts: Array<{ channel: string; text: string; threadTs?: string }>; threads: Map<string, SlackMessage[]>; search: Array<{ channel: string; ts: string; text: string }>; reminders: string[]; userReply(threadTs: string, text: string, user?: string): string; react(ts: string, name: string, user?: string): void }
  ```
- Behaviour:
  - `post()` redacts the text and truncates it to 39,000 characters (Slack's limit is 40k).
  - `replies()` excludes the thread root, returns only messages after `afterTs`, sorted ascending.
  - `mentions()` searches for `<@me>`, excludes my self-DM and returns only matches after `sinceTs`.
  - `reactions()` returns the reaction names **I** added to the given message.
  - `nudge()` creates a Slackbot reminder 60 s in the future (only used when `nudgeViaReminder` is on).

- [ ] **Step 1: Install and append the Slack fake**

Run: `pnpm --filter @orc/daemon add @slack/web-api@^8.1.1`

In `apps/daemon/test/p6-connector-fakes.ts`, add these imports next to the existing ones at the top of the file:
```ts
import type { SlackApi, SlackMessage } from '../src/connectors/slack/api.ts';
import { compareSlackTs } from '../src/connectors/slack/text.ts';
```
Then append:
```ts

const slackAuthError = () =>
  Object.assign(new Error('An API error occurred: invalid_auth'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'invalid_auth' },
  });

export function fakeSlackApi() {
  const control = { failAuth: false };
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const threads = new Map<string, SlackMessage[]>();
  const search: Array<{ channel: string; ts: string; text: string }> = [];
  const reminders: string[] = [];
  let seq = 100;
  const nextTs = () => `1758100000.${String(seq++).padStart(6, '0')}`;
  const push = (key: string, m: SlackMessage) => {
    const list = threads.get(key) ?? [];
    list.push(m);
    threads.set(key, list);
  };
  const api: SlackApi = {
    authTest: async () => {
      if (control.failAuth) throw slackAuthError();
      return { userId: 'U-ME', user: 'me', team: 'Acme' };
    },
    openDm: async () => 'D-ME',
    postMessage: async (channel, text, threadTs) => {
      if (control.failAuth) throw slackAuthError();
      const ts = nextTs();
      posts.push(threadTs ? { channel, text, threadTs } : { channel, text });
      push(threadTs ?? ts, { ts, user: 'U-ME', text, botId: null, appId: 'A-ORC', subtype: null, reactions: [] });
      return ts;
    },
    replies: async (_channel, threadTs, oldest) =>
      (threads.get(threadTs) ?? []).filter((m) => !oldest || m.ts === threadTs || compareSlackTs(m.ts, oldest) > 0),
    searchMessages: async () => search,
    addReminder: async (text) => {
      reminders.push(text);
    },
    oauthAccess: async () => ({ userToken: 'xoxp-from-oauth-123456', userId: 'U-ME', scopes: ['chat:write', 'im:history'] }),
  };
  return Object.assign(api, {
    control,
    posts,
    threads,
    search,
    reminders,
    userReply(threadTs: string, text: string, user = 'U-ME'): string {
      const ts = nextTs();
      push(threadTs, { ts, user, text, botId: null, appId: null, subtype: null, reactions: [] });
      return ts;
    },
    react(ts: string, name: string, user = 'U-ME'): void {
      const root = threads.get(ts)?.find((m) => m.ts === ts);
      if (!root) throw new Error(`no message ${ts}`);
      root.reactions.push({ name, users: [user] });
    },
  });
}
```

- [ ] **Step 2: Write the failing test**

`apps/daemon/src/connectors/slack/slack.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createSlackConnector, toSlackError } from './slack.ts';
import { compareSlackTs, decodeSlackText, slackTsFromDate } from './text.ts';

function setup(token: string | null = 'xoxp-test-123456') {
  const api = fakeSlackApi();
  const slack = createSlackConnector({
    secrets: createMemorySecretStore(token ? { 'slack.token': token } : {}),
    api: () => api,
    now: () => Date.parse('2026-09-17T10:00:00.000Z'),
  });
  return { api, slack };
}

describe('slack text helpers', () => {
  it('compares timestamps numerically', () => {
    expect(compareSlackTs('1758100000.000100', '1758100000.000099')).toBe(1);
    expect(compareSlackTs('1758099999.999999', '1758100000.000000')).toBe(-1);
    expect(compareSlackTs('10.5', '10.500000')).toBe(0);
    expect(slackTsFromDate(new Date(1758100000123))).toBe('1758100000.123000');
    expect(decodeSlackText('a &lt;b&gt; &amp; c')).toBe('a <b> & c');
  });
});

describe('SlackConnector', () => {
  it('reports status and identity', async () => {
    expect(await setup(null).slack.status()).toBe('unauthenticated');
    const s = setup();
    expect(await s.slack.me()).toEqual({ userId: 'U-ME', dmChannelId: 'D-ME', label: 'me @ Acme' });
    expect(await s.slack.status()).toBe('ok');
    s.api.control.failAuth = true;
    s.slack.invalidate();
    expect(await s.slack.status()).toBe('unauthenticated');
  });

  it('redacts posts and returns only newer thread replies', async () => {
    const s = setup();
    const root = await s.slack.post('D-ME', 'key xoxb-123456-abcdef leaked');
    expect(s.api.posts[0]?.text).toBe('key «redacted:slack» leaked');
    const first = s.api.userReply(root.ts, 'yes');
    const second = s.api.userReply(root.ts, 'and run tests');
    expect((await s.slack.replies('D-ME', root.ts)).map((r) => r.text)).toEqual(['yes', 'and run tests']);
    const after = await s.slack.replies('D-ME', root.ts, first);
    expect(after).toEqual([{ ts: second, user: 'U-ME', text: 'and run tests', botId: null, appId: null }]);
  });

  it('returns my reactions on a message', async () => {
    const s = setup();
    const root = await s.slack.post('D-ME', 'item');
    s.api.react(root.ts, 'white_check_mark');
    s.api.react(root.ts, 'eyes', 'U-OTHER');
    expect(await s.slack.reactions('D-ME', root.ts)).toEqual(['white_check_mark']);
  });

  it('finds mentions after a timestamp, excluding my DM', async () => {
    const s = setup();
    s.api.search.push(
      { channel: 'C1', ts: '1758100001.000000', text: 'hey <@U-ME> review?' },
      { channel: 'C1', ts: '1758099000.000000', text: 'old' },
      { channel: 'D-ME', ts: '1758100002.000000', text: 'self' },
    );
    expect(await s.slack.mentions('1758100000.000000')).toEqual([
      { channel: 'C1', ts: '1758100001.000000', text: 'hey <@U-ME> review?' },
    ]);
  });

  it('nudges with a redacted reminder', async () => {
    const s = setup();
    await s.slack.nudge('Waiting: token=abc');
    expect(s.api.reminders).toEqual(['Waiting: token=«redacted:secret»']);
  });

  it('maps Slack platform errors', () => {
    const e = (error: string) => Object.assign(new Error(error), { data: { error } });
    expect(toSlackError(e('token_revoked')).code).toBe('unauthenticated');
    expect(toSlackError(e('channel_not_found')).code).toBe('not_found');
    expect(toSlackError(e('missing_scope')).code).toBe('bad_request');
    expect(toSlackError(new Error('ETIMEDOUT')).code).toBe('upstream_error');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/connectors/slack`
Expected: FAIL, `Cannot find module './text.ts'`

- [ ] **Step 4: Implement the text helpers, the adapter and the connector**

`apps/daemon/src/connectors/slack/text.ts`
```ts
/** Slack timestamps are "<seconds>.<microseconds>" strings; compare them numerically without float rounding. */
export function compareSlackTs(a: string, b: string): number {
  const [as = '0', af = '0'] = a.split('.');
  const [bs = '0', bf = '0'] = b.split('.');
  const bySeconds = Number(as) - Number(bs);
  if (bySeconds !== 0) return Math.sign(bySeconds);
  return Math.sign(Number(af.padEnd(6, '0')) - Number(bf.padEnd(6, '0')));
}

export function slackTsFromDate(d: Date): string {
  const ms = d.getTime();
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

export function decodeSlackText(t: string): string {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
```

`apps/daemon/src/connectors/slack/api.ts`
```ts
import { WebClient } from '@slack/web-api';

export interface SlackMessage {
  ts: string;
  user: string | null;
  text: string;
  botId: string | null;
  appId: string | null;
  subtype: string | null;
  reactions: Array<{ name: string; users: string[] }>;
}

export interface SlackApi {
  authTest(): Promise<{ userId: string; user: string; team: string }>;
  openDm(userId: string): Promise<string>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
  replies(channel: string, threadTs: string, oldest?: string): Promise<SlackMessage[]>;
  searchMessages(query: string, count: number): Promise<Array<{ channel: string; ts: string; text: string }>>;
  addReminder(text: string, time: number): Promise<void>;
  oauthAccess(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{
    userToken: string;
    userId: string;
    scopes: string[];
  }>;
}

export function createSlackWebApi(token: string | null): SlackApi {
  const client = token ? new WebClient(token) : new WebClient();
  return {
    async authTest() {
      const r = await client.auth.test();
      if (!r.user_id) throw new Error('Slack auth.test returned no user');
      return { userId: r.user_id, user: r.user ?? '', team: r.team ?? '' };
    },
    async openDm(userId) {
      const r = await client.conversations.open({ users: userId });
      const id = r.channel?.id;
      if (!id) throw new Error('Slack did not return a DM channel');
      return id;
    },
    async postMessage(channel, text, threadTs) {
      const r = threadTs
        ? await client.chat.postMessage({ channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false })
        : await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
      if (!r.ts) throw new Error('Slack did not return a message timestamp');
      return r.ts;
    },
    async replies(channel, threadTs, oldest) {
      const r = await client.conversations.replies({ channel, ts: threadTs, limit: 200, ...(oldest ? { oldest } : {}) });
      return (r.messages ?? []).map((m) => ({
        ts: m.ts ?? '',
        user: m.user ?? null,
        text: m.text ?? '',
        botId: m.bot_id ?? null,
        appId: m.app_id ?? null,
        subtype: (m as { subtype?: string }).subtype ?? null,
        reactions: (m.reactions ?? []).map((x) => ({ name: x.name ?? '', users: x.users ?? [] })),
      }));
    },
    async searchMessages(query, count) {
      const r = await client.search.messages({ query, count, sort: 'timestamp', sort_dir: 'desc' });
      return (r.messages?.matches ?? [])
        .map((m) => ({ channel: m.channel?.id ?? '', ts: m.ts ?? '', text: m.text ?? '' }))
        .filter((m) => m.channel !== '' && m.ts !== '');
    },
    async addReminder(text, time) {
      await client.reminders.add({ text, time });
    },
    async oauthAccess(i) {
      const r = await client.oauth.v2.access({
        client_id: i.clientId,
        client_secret: i.clientSecret,
        code: i.code,
        redirect_uri: i.redirectUri,
      });
      const u = r.authed_user;
      if (!u?.access_token || !u.id) throw new Error('Slack did not return a user token (check the user scopes)');
      return { userToken: u.access_token, userId: u.id, scopes: (u.scope ?? '').split(',').filter((s) => s !== '') };
    },
  };
}
```

`apps/daemon/src/connectors/slack/slack.ts`
```ts
import { redact } from '@orc/core';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { type SlackApi, createSlackWebApi } from './api.ts';
import { compareSlackTs } from './text.ts';

export interface SlackReply {
  ts: string;
  user: string;
  text: string;
  botId: string | null;
  appId: string | null;
}

export interface SlackConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  me(): Promise<{ userId: string; dmChannelId: string; label: string }>;
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  replies(channel: string, threadTs: string, afterTs?: string): Promise<SlackReply[]>;
  mentions(sinceTs: string): Promise<Array<{ channel: string; ts: string; text: string }>>;
  reactions(channel: string, ts: string): Promise<string[]>;
  nudge(text: string): Promise<void>;
  invalidate(): void;
}

export interface SlackConnectorDeps {
  secrets: SecretStore;
  api?: (token: string | null) => SlackApi;
  now?: () => number;
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);
const NOT_FOUND = new Set(['channel_not_found', 'thread_not_found', 'message_not_found']);
const BAD_REQUEST = new Set(['missing_scope', 'not_in_channel', 'is_archived', 'invalid_arguments', 'msg_too_long']);

export function toSlackError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const code = (e as { data?: { error?: unknown } } | null)?.data?.error;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof code === 'string') {
    if (AUTH_ERRORS.has(code)) return new ConnectorError('unauthenticated', `Slack: ${code}`);
    if (NOT_FOUND.has(code)) return new ConnectorError('not_found', `Slack: ${code}`);
    if (BAD_REQUEST.has(code)) return new ConnectorError('bad_request', `Slack: ${code}`);
  }
  return new ConnectorError('upstream_error', message);
}

const byTs = <T extends { ts: string }>(a: T, b: T) => compareSlackTs(a.ts, b.ts);

export function createSlackConnector(d: SlackConnectorDeps): SlackConnector {
  const factory = d.api ?? createSlackWebApi;
  const now = d.now ?? Date.now;
  let current: { token: string; api: SlackApi } | null = null;
  let identity: { userId: string; dmChannelId: string; label: string } | null = null;

  function reset(): void {
    current = null;
    identity = null;
  }

  async function run<T>(fn: (api: SlackApi) => Promise<T>): Promise<T> {
    const token = await d.secrets.get('slack.token');
    if (!token) throw new ConnectorError('unauthenticated', 'Slack is not connected');
    let api: SlackApi;
    if (current !== null && current.token === token) {
      api = current.api;
    } else {
      reset();
      api = factory(token);
      current = { token, api };
    }
    try {
      return await fn(api);
    } catch (e) {
      throw toSlackError(e);
    }
  }

  async function me(): Promise<{ userId: string; dmChannelId: string; label: string }> {
    return run(async (api) => {
      if (identity) return identity;
      const a = await api.authTest();
      const dm = await api.openDm(a.userId);
      const value = { userId: a.userId, dmChannelId: dm, label: `${a.user} @ ${a.team}` };
      identity = value;
      return value;
    });
  }

  return {
    async status() {
      try {
        await me();
        return 'ok';
      } catch (e) {
        return e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
      }
    },
    me,
    async post(channel, text, threadTs) {
      const safe = redact(text).slice(0, 39_000);
      const ts = await run((api) => api.postMessage(channel, safe, threadTs));
      return { ts };
    },
    async replies(channel, threadTs, afterTs) {
      const messages = await run((api) => api.replies(channel, threadTs, afterTs));
      return messages
        .filter((m) => m.ts !== threadTs && (afterTs === undefined || compareSlackTs(m.ts, afterTs) > 0))
        .sort(byTs)
        .map((m) => ({ ts: m.ts, user: m.user ?? '', text: m.text, botId: m.botId, appId: m.appId }));
    },
    async mentions(sinceTs) {
      const who = await me();
      const found = await run((api) => api.searchMessages(`<@${who.userId}>`, 50));
      return found.filter((m) => m.channel !== who.dmChannelId && compareSlackTs(m.ts, sinceTs) > 0).sort(byTs);
    },
    async reactions(channel, ts) {
      const who = await me();
      const messages = await run((api) => api.replies(channel, ts));
      const root = messages.find((m) => m.ts === ts);
      return (root?.reactions ?? []).filter((r) => r.users.includes(who.userId)).map((r) => r.name);
    },
    async nudge(text) {
      const safe = redact(text).slice(0, 200);
      await run((api) => api.addReminder(safe, Math.floor(now() / 1000) + 60));
    },
    invalidate: reset,
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/connectors/slack`
Expected: PASS (7 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add Slack connector acting as the user"
```

---

### Task 7: Connector routes — status, token paste, OAuth app, OAuth callback, disconnect

**Files:**
- Create: `apps/daemon/src/connectors/oauth.ts`, `apps/daemon/src/connectors/oauth.test.ts`
- Create: `apps/daemon/src/http/routes/connectors.ts`, `apps/daemon/src/http/routes/connectors.test.ts`
- Create: `apps/daemon/test/p6-app.ts`
- Modify: `apps/daemon/src/http/auth.ts` (add `PUBLIC_API_PATHS`), `apps/daemon/src/http/app.ts` (skip the token check for those paths)

**Interfaces:**
- Consumes:
  - `SecretStore` (Task 4)
  - `LinearConnector` (Task 5)
  - `SlackConnector`, `SlackApi`, `createSlackWebApi` (Task 6)
  - `ConnectorError`, `withTimeout` (Task 5)
  - repo functions from `db/repos/connectors.ts` (Task 3)
  - `ConnectorId`, `ConnectorStatus`, `TokenBody`, `OAuthAppBody`, `ConfirmBody` (Task 2)
  - `requireLoopback`, `whoOf`, `confirmOr409`, `need`, `Who` (Task 2)
  - `readJson` (P1), `ServiceError` (P1), `apiError`
- Produces:
  ```ts
  // connectors/oauth.ts
  export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresInSec: number | null; accountId: string | null; scopes: string[] }
  export interface OAuthProvider { id: ConnectorKey; authorizeUrl(i: { clientId: string; redirectUri: string; state: string }): string; exchange(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<OAuthTokens>; refresh?(i: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokens> }
  export const SLACK_USER_SCOPES: readonly string[]
  export function slackOAuthProvider(api?: (token: string | null) => SlackApi): OAuthProvider
  export interface OAuthStateStore { create(connector: ConnectorKey): string; consume(state: string, connector: ConnectorKey): boolean }
  export function createOAuthStateStore(o?: { ttlMs?: number; now?: () => number }): OAuthStateStore
  // http/routes/connectors.ts
  export interface ConnectorRouteDeps { secrets: SecretStore; linear: LinearConnector; slack: SlackConnector; providers: Partial<Record<ConnectorKey, OAuthProvider>>; oauthState: OAuthStateStore; now?: () => Date }
  export function registerConnectorRoutes(app: OrcApp, ctx: DaemonContext, d: ConnectorRouteDeps): void
  // http/auth.ts
  export const PUBLIC_API_PATHS: ReadonlySet<string>   // '/api/connectors/linear/callback', '/api/connectors/slack/callback'
  // test/p6-app.ts
  export function p6TestApp(): OrcApp     // Hono<OrcEnv> + withRemote + onError like createApp
  ```
- Behaviour:
  - A pasted token is written to the Keychain, then verified with `me()`.
    - On failure, the previous token is restored (or deleted if there was none), the response is `400 invalid_token`, and an audit `connector.connect` entry with result `error` is recorded.
    - On success, the metadata row is upserted and `connector.connect` is audited with result `ok`. The audit params contain **no token**.
  - The callback accepts each OAuth `state` once, within 10 minutes, for the connector that created it.
  - Every write route is loopback-only.

- [ ] **Step 1: Write the test app helper**

`apps/daemon/test/p6-app.ts`
```ts
import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { OrcApp, OrcEnv } from '../src/http/types.ts';
import { ServiceError } from '../src/services/errors.ts';
import { withRemote } from './p6-fakes.ts';

export function p6TestApp(): OrcApp {
  const app = withRemote(new Hono<OrcEnv>());
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(apiError(err.code, err.message, err.details), err.status);
    if (err instanceof ZodError) return c.json(apiError('validation_failed', 'invalid request', err.issues), 400);
    return c.json(apiError('internal', err instanceof Error ? err.message : String(err)), 500);
  });
  return app;
}

export async function send(
  app: OrcApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(`http://127.0.0.1:4317${path}`, {
    method,
    headers: { 'content-type': 'application/json', host: '127.0.0.1:4317', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/connectors/oauth.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { fakeSlackApi } from '../../test/p6-connector-fakes.ts';
import { SLACK_USER_SCOPES, createOAuthStateStore, slackOAuthProvider } from './oauth.ts';

describe('OAuth helpers', () => {
  it('builds the Slack user-scope authorize URL', () => {
    const url = new URL(slackOAuthProvider(() => fakeSlackApi()).authorizeUrl({ clientId: '123.456', redirectUri: 'http://127.0.0.1:4317/api/connectors/slack/callback', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(SLACK_USER_SCOPES.join(','));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('exchanges a code for the authed_user token', async () => {
    const tokens = await slackOAuthProvider(() => fakeSlackApi()).exchange({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r' });
    expect(tokens).toEqual({ accessToken: 'xoxp-from-oauth-123456', refreshToken: null, expiresInSec: null, accountId: 'U-ME', scopes: ['chat:write', 'im:history'] });
  });

  it('accepts a state once, for the right connector, before it expires', () => {
    let now = 0;
    const store = createOAuthStateStore({ ttlMs: 1000, now: () => now });
    const a = store.create('slack');
    expect(store.consume(a, 'linear')).toBe(false);
    const b = store.create('slack');
    expect(store.consume(b, 'slack')).toBe(true);
    expect(store.consume(b, 'slack')).toBe(false);
    const c = store.create('slack');
    now = 1001;
    expect(store.consume(c, 'slack')).toBe(false);
  });
});
```

`apps/daemon/src/http/routes/connectors.test.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { send, p6TestApp } from '../../../test/p6-app.ts';
import { fakeLinearApi, fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { p6Context } from '../../../test/p6-fakes.ts';
import { useTempHomes } from '../../../test/helpers.ts';
import { createLinearConnector } from '../../connectors/linear/linear.ts';
import { type OAuthProvider, createOAuthStateStore } from '../../connectors/oauth.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import { getConnectorMeta } from '../../db/repos/connectors.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { registerConnectorRoutes } from './connectors.ts';

describe('connector routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup() {
    const { ctx, audit } = p6Context();
    cleanups.push(() => ctx.dispose());
    const secrets = createMemorySecretStore();
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    const exchange = vi.fn<OAuthProvider['exchange']>(async () => ({
      accessToken: 'xoxp-oauth-token-123456', refreshToken: null, expiresInSec: null, accountId: 'U-ME', scopes: ['chat:write'],
    }));
    const provider: OAuthProvider = {
      id: 'slack',
      authorizeUrl: ({ clientId, redirectUri, state }) => `https://slack.test/auth?c=${clientId}&r=${encodeURIComponent(redirectUri)}&state=${state}`,
      exchange,
    };
    const app = p6TestApp();
    registerConnectorRoutes(app, ctx, { secrets, linear, slack, providers: { slack: provider }, oauthState: createOAuthStateStore() });
    return { ctx, audit, secrets, app, linearApi, slackApi, exchange };
  }

  it('connects Slack with a pasted token that never reaches SQLite', async () => {
    const s = setup();
    const token = 'xoxp-secret-token-987654321';
    const res = await send(s.app, 'POST', '/api/connectors/slack/token', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'slack', connected: true, status: 'ok', authKind: 'user_token', accountLabel: 'me @ Acme' });
    expect(await s.secrets.get('slack.token')).toBe(token);
    for (const f of [s.ctx.paths.dbFile, `${s.ctx.paths.dbFile}-wal`]) {
      if (existsSync(f)) expect(readFileSync(f).toString('latin1').includes(token)).toBe(false);
    }
    const entry = s.audit.list({ action: 'connector.connect' })[0];
    expect(entry).toMatchObject({ result: 'ok', target: 'slack' });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('rejects malformed and invalid tokens and restores the previous state', async () => {
    const s = setup();
    expect((await send(s.app, 'POST', '/api/connectors/slack/token', { token: 'xoxb-bot-token-123' })).status).toBe(400);
    s.linearApi.control.failAuth = true;
    const res = await send(s.app, 'POST', '/api/connectors/linear/token', { token: 'lin_api_bad_token_1' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    expect(await s.secrets.get('linear.token')).toBeNull();
    expect(getConnectorMeta(s.ctx.db, 'linear')).toBeNull();
    expect(s.audit.list({ action: 'connector.connect' })[0]?.result).toBe('error');
  });

  it('refuses writes from remote devices', async () => {
    const s = setup();
    const res = await send(s.app, 'POST', '/api/connectors/slack/token', { token: 'xoxp-1234567890-abc' }, { 'x-test-remote': 'd1' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('loopback_only');
  });

  it('runs the OAuth flow once per state', async () => {
    const s = setup();
    expect((await send(s.app, 'GET', '/api/connectors/slack/authorize')).status).toBe(409);
    expect((await send(s.app, 'POST', '/api/connectors/slack/app', { clientId: '123.456', clientSecret: 'shhh-secret-1' })).status).toBe(200);
    const { url } = (await (await send(s.app, 'GET', '/api/connectors/slack/authorize')).json()) as { url: string };
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:4317/api/connectors/slack/callback'));
    const ok = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Connected');
    expect(s.exchange).toHaveBeenCalledWith({
      clientId: '123.456', clientSecret: 'shhh-secret-1', code: 'abc', redirectUri: 'http://127.0.0.1:4317/api/connectors/slack/callback',
    });
    expect(await s.secrets.get('slack.token')).toBe('xoxp-oauth-token-123456');
    expect(getConnectorMeta(s.ctx.db, 'slack')?.authKind).toBe('oauth');
    const replay = await send(s.app, 'GET', `/api/connectors/slack/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);
    const denied = await send(s.app, 'GET', '/api/connectors/slack/callback?error=access_denied&state=x');
    expect(await denied.text()).toContain('access_denied');
  });

  it('escapes provider errors in the callback page', async () => {
    const s = setup();
    const res = await send(s.app, 'GET', '/api/connectors/slack/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(await res.text()).not.toContain('<script>');
  });

  it('disconnects only with confirmation', async () => {
    const s = setup();
    await send(s.app, 'POST', '/api/connectors/linear/token', { token: 'lin_api_good_token_1' });
    const first = await send(s.app, 'DELETE', '/api/connectors/linear', {});
    expect(first.status).toBe(409);
    expect(((await first.json()) as { error: { details: { summary: string } } }).error.details.summary).toContain('Disconnect linear');
    expect((await send(s.app, 'DELETE', '/api/connectors/linear', { confirm: true })).status).toBe(200);
    expect(await s.secrets.get('linear.token')).toBeNull();
    const list = (await (await send(s.app, 'GET', '/api/connectors')).json()) as Array<{ id: string; connected: boolean }>;
    expect(list).toEqual([
      expect.objectContaining({ id: 'linear', connected: false }),
      expect.objectContaining({ id: 'slack', connected: false }),
    ]);
    expect(s.audit.list({ action: 'connector.disconnect' })).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/connectors/oauth.test.ts apps/daemon/src/http/routes/connectors.test.ts`
Expected: FAIL, `Cannot find module './oauth.ts'`

- [ ] **Step 4: Implement the OAuth helpers**

`apps/daemon/src/connectors/oauth.ts`
```ts
import { randomBytes } from 'node:crypto';
import type { ConnectorKey } from '../db/repos/connectors.ts';
import { type SlackApi, createSlackWebApi } from './slack/api.ts';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  accountId: string | null;
  scopes: string[];
}

export interface OAuthProvider {
  id: ConnectorKey;
  authorizeUrl(i: { clientId: string; redirectUri: string; state: string }): string;
  exchange(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh?(i: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokens>;
}

export const SLACK_USER_SCOPES: readonly string[] = [
  'chat:write',
  'im:write',
  'im:history',
  'channels:history',
  'groups:history',
  'search:read',
  'users:read',
  'reminders:write',
];

export function slackOAuthProvider(api: (token: string | null) => SlackApi = createSlackWebApi): OAuthProvider {
  return {
    id: 'slack',
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL('https://slack.com/oauth/v2/authorize');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(i) {
      const r = await api(null).oauthAccess(i);
      return { accessToken: r.userToken, refreshToken: null, expiresInSec: null, accountId: r.userId, scopes: r.scopes };
    },
  };
}

export interface OAuthStateStore {
  create(connector: ConnectorKey): string;
  consume(state: string, connector: ConnectorKey): boolean;
}

export function createOAuthStateStore(o: { ttlMs?: number; now?: () => number } = {}): OAuthStateStore {
  const ttl = o.ttlMs ?? 10 * 60_000;
  const now = o.now ?? Date.now;
  const states = new Map<string, { connector: ConnectorKey; exp: number }>();
  return {
    create(connector) {
      for (const [k, v] of states) if (v.exp <= now()) states.delete(k);
      const state = randomBytes(24).toString('base64url');
      states.set(state, { connector, exp: now() + ttl });
      return state;
    },
    consume(state, connector) {
      const v = states.get(state);
      states.delete(state);
      return v !== undefined && v.connector === connector && v.exp > now();
    },
  };
}
```

- [ ] **Step 5: Implement the routes**

`apps/daemon/src/http/routes/connectors.ts`
```ts
import { ConfirmBody, ConnectorId, type ConnectorStatus, OAuthAppBody, TokenBody } from '@orc/api-contract';
import type { OrcConfig } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import type { OAuthProvider, OAuthStateStore } from '../../connectors/oauth.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import { withTimeout } from '../../connectors/util.ts';
import {
  type ConnectorAuthKind,
  type ConnectorHealth,
  type ConnectorKey,
  deleteConnectorMeta,
  getConnectorMeta,
  setConnectorStatus,
  upsertConnectorMeta,
} from '../../db/repos/connectors.ts';
import { ServiceError } from '../../services/errors.ts';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { readJson } from '../json.ts';
import { type Who, confirmOr409, need, requireLoopback, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export interface ConnectorRouteDeps {
  secrets: SecretStore;
  linear: LinearConnector;
  slack: SlackConnector;
  providers: Partial<Record<ConnectorKey, OAuthProvider>>;
  oauthState: OAuthStateStore;
  now?: () => Date;
}

const IDS: readonly ConnectorKey[] = ['linear', 'slack'];
const NAMES: Record<ConnectorKey, string> = { linear: 'Linear', slack: 'Slack' };
const TOKEN_FORMAT: Record<ConnectorKey, RegExp> = {
  linear: /^lin_(api|oauth)_[A-Za-z0-9_]+$/,
  slack: /^xoxp-[A-Za-z0-9-]+$/,
};

function parseId(raw: string): ConnectorKey {
  const r = ConnectorId.safeParse(raw);
  if (!r.success) throw new ServiceError('not_found', 404, `unknown connector ${raw}`);
  return r.data;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui;padding:2rem"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/settings">Back to Settings</a></p></body></html>`;
}

const redirectUriFor = (cfg: OrcConfig, id: ConnectorKey) => cfg.connectors[id].redirectUri;

export function registerConnectorRoutes(app: OrcApp, ctx: DaemonContext, d: ConnectorRouteDeps): void {
  const nowIso = () => (d.now ? d.now() : new Date()).toISOString();
  const audit = () => need(ctx.audit, 'audit');
  const connectorOf = (id: ConnectorKey) => (id === 'linear' ? d.linear : d.slack);

  async function identify(id: ConnectorKey): Promise<{ accountId: string; label: string }> {
    connectorOf(id).invalidate();
    if (id === 'linear') {
      const me = await d.linear.me();
      return { accountId: me.id, label: `${me.name} <${me.email}>` };
    }
    const me = await d.slack.me();
    return { accountId: me.userId, label: me.label };
  }

  async function oauthApp(id: ConnectorKey): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientId = await d.secrets.get(`${id}.client_id`);
    const clientSecret = await d.secrets.get(`${id}.client_secret`);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  async function statusOf(id: ConnectorKey): Promise<ConnectorStatus> {
    const meta = getConnectorMeta(ctx.db, id);
    const oauthConfigured = d.providers[id] !== undefined && (await oauthApp(id)) !== null;
    if (!meta) {
      return { id, connected: false, status: 'unauthenticated', authKind: null, accountLabel: null, connectedAt: null, lastCheckedAt: null, oauthConfigured };
    }
    let status: ConnectorHealth;
    try {
      status = await withTimeout(connectorOf(id).status(), 5000, `${id} status`);
    } catch {
      status = 'error';
    }
    const at = nowIso();
    setConnectorStatus(ctx.db, id, status, at);
    return { id, connected: true, status, authKind: meta.authKind, accountLabel: meta.accountLabel, connectedAt: meta.connectedAt, lastCheckedAt: at, oauthConfigured };
  }

  async function saveToken(
    id: ConnectorKey,
    token: string,
    authKind: ConnectorAuthKind,
    extras: { refreshToken?: string | null; expiresInSec?: number | null; scopes?: string[] },
    who: Who,
  ): Promise<string> {
    const previous = await d.secrets.get(`${id}.token`);
    await d.secrets.set(`${id}.token`, token);
    let ident: { accountId: string; label: string };
    try {
      ident = await identify(id);
    } catch (e) {
      if (previous) await d.secrets.set(`${id}.token`, previous);
      else await d.secrets.delete(`${id}.token`);
      connectorOf(id).invalidate();
      audit().record({
        ...who, action: 'connector.connect', target: id, params: { authKind },
        result: 'error', error: e instanceof Error ? e.message : String(e),
      });
      throw new ServiceError('invalid_token', 400, `${NAMES[id]} rejected the token`);
    }
    if (extras.refreshToken) await d.secrets.set(`${id}.refresh_token`, extras.refreshToken);
    else await d.secrets.delete(`${id}.refresh_token`);
    const cursor = extras.expiresInSec
      ? { tokenExpiresAt: new Date(Date.now() + extras.expiresInSec * 1000).toISOString() }
      : {};
    upsertConnectorMeta(ctx.db, {
      connector: id, authKind, accountId: ident.accountId, accountLabel: ident.label,
      scopes: extras.scopes ?? [], connectedAt: nowIso(), cursor,
    });
    audit().record({
      ...who, action: 'connector.connect', target: id, params: { authKind, account: ident.label },
      result: 'ok', error: null,
    });
    return ident.label;
  }

  app.get('/api/connectors', async (c) => {
    requireLoopback(c);
    return c.json(await Promise.all(IDS.map(statusOf)));
  });

  app.post('/api/connectors/:id/token', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const { token } = await readJson(c, TokenBody);
    if (!TOKEN_FORMAT[id].test(token)) {
      throw new ServiceError(
        'invalid_token_format',
        400,
        id === 'slack' ? 'expected a Slack user token (xoxp-…)' : 'expected a Linear API key (lin_api_…)',
      );
    }
    const authKind: ConnectorAuthKind = id === 'slack' ? 'user_token' : token.startsWith('lin_oauth_') ? 'oauth' : 'api_key';
    await saveToken(id, token, authKind, {}, whoOf(c));
    return c.json(await statusOf(id));
  });

  app.post('/api/connectors/:id/app', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const body = await readJson(c, OAuthAppBody);
    await d.secrets.set(`${id}.client_id`, body.clientId);
    await d.secrets.set(`${id}.client_secret`, body.clientSecret);
    audit().record({
      ...whoOf(c), action: 'connector.configure', target: id, params: { clientId: body.clientId },
      result: 'ok', error: null,
    });
    return c.json({ ok: true as const });
  });

  app.get('/api/connectors/:id/authorize', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const provider = d.providers[id];
    if (!provider) throw new ServiceError('not_found', 404, `${NAMES[id]} has no OAuth flow here; paste a token instead`);
    const creds = await oauthApp(id);
    if (!creds) throw new ServiceError('oauth_not_configured', 409, 'save the OAuth client id and secret first');
    const state = d.oauthState.create(id);
    return c.json({ url: provider.authorizeUrl({ clientId: creds.clientId, redirectUri: redirectUriFor(ctx.config(), id), state }) });
  });

  // Public (no token): the browser arrives here from the provider. Protected by the one-time state.
  app.get('/api/connectors/:id/callback', async (c) => {
    const parsed = ConnectorId.safeParse(c.req.param('id'));
    if (!parsed.success) return c.html(page('Not connected', 'Unknown connector.'), 404);
    const id = parsed.data;
    const q = c.req.query();
    if (q.error) return c.html(page('Not connected', `${NAMES[id]} returned: ${q.error}`), 400);
    if (!q.state || !q.code || !d.oauthState.consume(q.state, id)) {
      return c.html(page('Not connected', 'This link expired or was already used. Start again from Settings → Connectors.'), 400);
    }
    const provider = d.providers[id];
    const creds = await oauthApp(id);
    if (!provider || !creds) return c.html(page('Not connected', 'The OAuth app is not configured.'), 409);
    try {
      const tokens = await provider.exchange({ ...creds, code: q.code, redirectUri: redirectUriFor(ctx.config(), id) });
      const label = await saveToken(
        id,
        tokens.accessToken,
        'oauth',
        { refreshToken: tokens.refreshToken, expiresInSec: tokens.expiresInSec, scopes: tokens.scopes },
        { actor: 'user', actorDetail: 'oauth callback' },
      );
      return c.html(page('Connected', `${NAMES[id]} is connected as ${label}. You can close this tab.`));
    } catch (e) {
      return c.html(page('Not connected', e instanceof Error ? e.message : String(e)), 400);
    }
  });

  app.delete('/api/connectors/:id', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const { confirm } = await readJson(c, ConfirmBody);
    confirmOr409(confirm, `Disconnect ${id}? The token is removed from the Keychain and the app stops posting and polling.`);
    await d.secrets.delete(`${id}.token`);
    await d.secrets.delete(`${id}.refresh_token`);
    deleteConnectorMeta(ctx.db, id);
    connectorOf(id).invalidate();
    audit().record({ ...whoOf(c), action: 'connector.disconnect', target: id, params: {}, result: 'ok', error: null });
    return c.json({ ok: true as const });
  });
}
```

- [ ] **Step 6: Let the callbacks through P1's token check**

In `apps/daemon/src/http/auth.ts`, append:
```ts
/** Browser redirects from OAuth providers carry no token; they are protected by a one-time `state` instead. */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  '/api/connectors/linear/callback',
  '/api/connectors/slack/callback',
]);
```

In `apps/daemon/src/http/app.ts`, inside the `/api/*` middleware, change the token check to:
```ts
    if (!PUBLIC_API_PATHS.has(c.req.path) && !tokenMatches(o.token, c.req.header('x-orc-token'))) {
      return c.json(apiError('unauthorized', 'missing or invalid token'), 401);
    }
```
Also add `PUBLIC_API_PATHS` to the import from `./auth.ts`. The host and Origin checks above it stay unchanged.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/connectors/oauth.test.ts apps/daemon/src/http/routes/connectors.test.ts apps/daemon/src/http`
Expected: PASS (3 + 6 new tests, and P1's app tests still pass)

- [ ] **Step 8: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add connector status, token, OAuth and disconnect routes"
```

---

### Task 8: Web — Settings → Connectors

**Files:**
- Create: `apps/web/src/api/queries/connectors.ts`
- Create: `apps/web/src/features/settings/ConnectorsPanel.tsx`, `apps/web/src/features/settings/ConnectorsPanel.test.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`

**Interfaces:**
- Consumes:
  - `getApiClient()` and `setApiClientForTests()` (P1)
  - the `connectors*` client methods (Task 2)
  - `renderWithClient` and `fakeApi` (P2 `src/test/query.tsx`)
  - UI kit `Button`, `Badge`, `Input`
- Produces:
  ```ts
  // api/queries/connectors.ts
  export function useConnectors(): UseQueryResult<ConnectorStatus[]>
  export function useSetConnectorToken(): UseMutationResult<ConnectorStatus, Error, { id: ConnectorId; token: string }>
  export function useSetConnectorApp(): UseMutationResult<{ ok: true }, Error, { id: ConnectorId; clientId: string; clientSecret: string }>
  export function useConnectorAuthorize(): UseMutationResult<{ url: string }, Error, ConnectorId>
  export function useDisconnectConnector(): UseMutationResult<{ ok: true }, Error, ConnectorId>
  // features/settings/ConnectorsPanel.tsx
  export function ConnectorsPanel(): JSX.Element
  ```
  Query key: `['connectors']`.

- [ ] **Step 1: Write the failing component test**

`apps/web/src/features/settings/ConnectorsPanel.test.tsx`
```tsx
import type { ConnectorStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { ConnectorsPanel } from './ConnectorsPanel.tsx';

const T = '2026-09-17T10:00:00.000Z';
const linearOk: ConnectorStatus = {
  id: 'linear', connected: true, status: 'ok', authKind: 'api_key', accountLabel: 'Test User <me@example.com>',
  connectedAt: T, lastCheckedAt: T, oauthConfigured: false,
};
const slackOff: ConnectorStatus = {
  id: 'slack', connected: false, status: 'unauthenticated', authKind: null, accountLabel: null,
  connectedAt: null, lastCheckedAt: null, oauthConfigured: false,
};

describe('ConnectorsPanel', () => {
  afterEach(() => {
    setApiClientForTests(null);
    vi.restoreAllMocks();
  });

  it('connects with a pasted token and disconnects after confirmation', async () => {
    const connectorsSetToken = vi.fn(async () => ({ ...slackOff, connected: true, status: 'ok' as const }));
    const connectorsDisconnect = vi.fn(async () => ({ ok: true as const }));
    setApiClientForTests(fakeApi({ connectorsList: async () => [linearOk, slackOff], connectorsSetToken, connectorsDisconnect }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithClient(<ConnectorsPanel />);

    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    fireEvent.change(within(slack).getByLabelText('Token'), { target: { value: 'xoxp-1234567890-abc' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectorsSetToken).toHaveBeenCalledWith('slack', 'xoxp-1234567890-abc'));

    const linear = screen.getByRole('region', { name: 'Linear connector' });
    expect(within(linear).getByText('Test User <me@example.com>')).toBeTruthy();
    fireEvent.click(within(linear).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(connectorsDisconnect).toHaveBeenCalledWith('linear', true));
  });

  it('keeps OAuth disabled until the app is configured, then saves the app', async () => {
    const connectorsSetApp = vi.fn(async () => ({ ok: true as const }));
    setApiClientForTests(fakeApi({ connectorsList: async () => [linearOk, slackOff], connectorsSetApp }));
    renderWithClient(<ConnectorsPanel />);
    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    expect((within(slack).getByRole('button', { name: 'Connect with Slack' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(slack).getByRole('button', { name: 'OAuth app…' }));
    fireEvent.change(within(slack).getByLabelText('Client ID'), { target: { value: '123.456' } });
    fireEvent.change(within(slack).getByLabelText('Client secret'), { target: { value: 'shhh-secret-1' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(connectorsSetApp).toHaveBeenCalledWith('slack', '123.456', 'shhh-secret-1'));
  });

  it('shows server errors', async () => {
    const err = Object.assign(new Error('Slack rejected the token'), { status: 400, code: 'invalid_token' });
    setApiClientForTests(fakeApi({ connectorsList: async () => [linearOk, slackOff], connectorsSetToken: vi.fn(async () => Promise.reject(err)) }));
    renderWithClient(<ConnectorsPanel />);
    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    fireEvent.change(within(slack).getByLabelText('Token'), { target: { value: 'xoxp-1234567890-abc' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Connect' }));
    expect((await within(slack).findByRole('alert')).textContent).toContain('Slack rejected the token');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/features/settings/ConnectorsPanel.test.tsx`
Expected: FAIL, `Cannot find module './ConnectorsPanel.tsx'`

- [ ] **Step 3: Implement the hooks and the panel**

`apps/web/src/api/queries/connectors.ts`
```ts
import type { ConnectorId } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const KEY = ['connectors'] as const;

export function useConnectors() {
  return useQuery({ queryKey: KEY, queryFn: () => getApiClient().connectorsList() });
}

function useInvalidateConnectors() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useSetConnectorToken() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (v: { id: ConnectorId; token: string }) => getApiClient().connectorsSetToken(v.id, v.token),
    onSuccess: invalidate,
  });
}

export function useSetConnectorApp() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (v: { id: ConnectorId; clientId: string; clientSecret: string }) =>
      getApiClient().connectorsSetApp(v.id, v.clientId, v.clientSecret),
    onSuccess: invalidate,
  });
}

export function useConnectorAuthorize() {
  return useMutation({ mutationFn: (id: ConnectorId) => getApiClient().connectorsAuthorize(id) });
}

export function useDisconnectConnector() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (id: ConnectorId) => getApiClient().connectorsDisconnect(id, true),
    onSuccess: invalidate,
  });
}
```

`apps/web/src/features/settings/ConnectorsPanel.tsx`
```tsx
import type { ConnectorId, ConnectorStatus } from '@orc/api-contract';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useConnectorAuthorize,
  useConnectors,
  useDisconnectConnector,
  useSetConnectorApp,
  useSetConnectorToken,
} from '../../api/queries/connectors.ts';

const INFO: Record<ConnectorId, { name: string; tokenHint: string; help: string }> = {
  linear: {
    name: 'Linear',
    tokenHint: 'lin_api_…',
    help: 'Linear → Settings → Security & access → Personal API keys → New key (read + write). The app acts as you.',
  },
  slack: {
    name: 'Slack',
    tokenHint: 'xoxp-…',
    help: 'Create the “Orchestrator (personal)” Slack app from the manifest in docs/setup-remote-and-connectors.md, install it, then paste the User OAuth Token or use Connect with Slack. The app acts as you.',
  },
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ConnectorsPanel() {
  const { data, isLoading, error } = useConnectors();
  if (isLoading) return <p>Loading connectors…</p>;
  if (error) return <p role="alert">Could not load connectors: {errorText(error)}</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(data ?? []).map((s) => (
        <ConnectorCard key={s.id} status={s} />
      ))}
    </div>
  );
}

function ConnectorCard({ status }: { status: ConnectorStatus }) {
  const info = INFO[status.id];
  const [token, setToken] = useState('');
  const [showApp, setShowApp] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const setTok = useSetConnectorToken();
  const setApp = useSetConnectorApp();
  const authorize = useConnectorAuthorize();
  const disconnect = useDisconnectConnector();
  const busy = setTok.isPending || setApp.isPending || authorize.isPending || disconnect.isPending;
  const err = setTok.error ?? setApp.error ?? authorize.error ?? disconnect.error;
  const healthy = status.connected && status.status === 'ok';

  return (
    <section aria-label={`${info.name} connector`} className="space-y-3 rounded-lg border p-4">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold">{info.name}</h3>
        <Badge variant={healthy ? 'default' : status.connected ? 'destructive' : 'secondary'}>
          {status.connected ? status.status : 'not connected'}
        </Badge>
      </header>

      {status.connected ? (
        <div className="space-y-2 text-sm">
          <p>
            Connected as <strong>{status.accountLabel ?? 'unknown account'}</strong> ({status.authKind})
          </p>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Disconnect ${info.name}? The token is removed from the Keychain.`)) disconnect.mutate(status.id);
            }}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTok.mutate({ id: status.id, token: token.trim() }, { onSuccess: () => setToken('') });
          }}
        >
          <p className="text-xs opacity-70">{info.help}</p>
          <label className="block text-sm">
            Token
            <Input
              type="password"
              autoComplete="off"
              placeholder={info.tokenHint}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || token.trim().length < 12}>
              Connect
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !status.oauthConfigured}
              onClick={() => authorize.mutate(status.id, { onSuccess: (r) => window.open(r.url, '_blank', 'noopener') })}
            >
              Connect with {info.name}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowApp((v) => !v)}>
              OAuth app…
            </Button>
          </div>
        </form>
      )}

      {showApp && (
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApp.mutate(
              { id: status.id, clientId: clientId.trim(), clientSecret: clientSecret.trim() },
              {
                onSuccess: () => {
                  setShowApp(false);
                  setClientSecret('');
                },
              },
            );
          }}
        >
          <label className="block text-sm">
            Client ID
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </label>
          <label className="block text-sm">
            Client secret
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </label>
          <Button type="submit" size="sm" disabled={busy || clientId.trim().length < 5 || clientSecret.trim().length < 10}>
            Save OAuth app
          </Button>
        </form>
      )}

      {err && (
        <p role="alert" className="text-sm text-red-600">
          {errorText(err)}
        </p>
      )}
    </section>
  );
}
```

In `apps/web/src/features/settings/SettingsPage.tsx`, add `import { ConnectorsPanel } from './ConnectorsPanel.tsx';` and a new section after the existing ones:
```tsx
      <section aria-labelledby="settings-connectors">
        <h2 id="settings-connectors" className="mb-3 text-lg font-semibold">Connectors</h2>
        <ConnectorsPanel />
      </section>
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/features/settings`
Expected: PASS (3 new tests; the existing settings tests still pass)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add Settings connectors panel for Linear and Slack"
```

---

### Task 9: ShareService and routes — Linear comments, follow-up tickets, Slack posts (redact → confirm → audit)

**Files:**
- Create: `apps/daemon/src/services/share/share.ts` (replaces the Task 2 stub)
- Create: `apps/daemon/src/http/routes/share.ts`, `apps/daemon/src/http/routes/share.test.ts`

**Interfaces:**
- Consumes:
  - `LinearConnector` (Task 5), `SlackConnector` (Task 6), `toServiceError` (Task 5)
  - `ShareSource`, `LinearCommentBody`, `LinearFollowUpBody`, `SlackPostBody`, `LINEAR_IDENTIFIER_RE` (Task 2)
  - `Who`, `whoOf`, `confirmOr409`, `need` (Task 2)
  - `audited` (P3); `RecapService.recap/daily` and `HandoffService.latest/generate/toMarkdown` (P5)
  - `ctx.paths.claudeHome`, `ctx.paths.userHome` (P1); `cfg.links.planRoots` (P3); `redact` (core)
- Produces:
  ```ts
  // services/share/share.ts
  export const MAX_SHARE_CHARS = 20_000;
  export type { ShareSource };
  export interface ShareService { compose(src: ShareSource): Promise<string>; commentOnLinear(identifier: string, body: string, who: Who): Promise<void>; createFollowUp(i: { sessionPk: string; teamKey: string; title: string; description: string; includeRecap: boolean }, who: Who): Promise<LinearIssue>; postToSlack(channel: string, text: string, who: Who): Promise<{ ts: string }> }
  export function createShareService(d: { ctx: DaemonContext; linear: LinearConnector; slack: SlackConnector }): ShareService
  // http/routes/share.ts
  export function registerShareRoutes(app: OrcApp, ctx: DaemonContext, d: { share: ShareService; linear: LinearConnector }): void
  ```
- Behaviour:
  - `compose()` builds the text and always returns it redacted, trimmed and capped at 20,000 chars. Sources:
    - recap → on-demand recap with a title line
    - handoff → the latest handoff, or a newly generated one, as markdown
    - plan → a `.md` file whose real path is inside `$CLAUDE_HOME/plans` or a `links.planRoots` entry, otherwise `403 forbidden`
    - daily → `recaps.daily()` with a title line
    - text → the text as given
  - Every post route is a two-step flow:
    1. Without `confirm`, it returns `409 confirmation_required` with `details = { summary, preview, … }`.
    2. The client confirms by re-sending **the previewed text** as `{ kind: 'text', text: preview }` with `confirm: true`, so what gets posted is exactly what the user saw.
  - Audit actions and the params they record (no full body):
    - `linear.comment`: target = identifier; params `{ chars, preview }` (first 300 redacted chars)
    - `linear.issue.create`: target = teamKey
    - `slack.post`: target = channel
  - Follow-up tickets are **assigned to me**. The team key comes from `body.teamKey`, then `connectors.linear.defaultTeamKey`, then the prefix of the session's first ticket.
  - `POST /api/slack/post` without a `channel` uses `connectors.slack.dailyChannel`. If neither is set, it returns `400`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/http/routes/share.test.ts`
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Handoff } from '@orc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { send, p6TestApp } from '../../../test/p6-app.ts';
import { fakeLinearApi, fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { makeP6Session, p6Context } from '../../../test/p6-fakes.ts';
import { useTempHomes } from '../../../test/helpers.ts';
import { createLinearConnector } from '../../connectors/linear/linear.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import type { HandoffService } from '../../services/handoff/handoff.ts';
import type { RecapService } from '../../services/recap/recap.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createShareService } from '../../services/share/share.ts';
import { registerShareRoutes } from './share.ts';

type ErrBody = { error: { code: string; details?: { summary: string; preview: string } } };

describe('share routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(o: { config?: Record<string, unknown>; linearToken?: boolean } = {}) {
    const session = makeP6Session({ id: 's1', name: 'SAF-1787 SLA weekends', tickets: ['SAF-1787'] });
    const { ctx, audit } = p6Context({ sessions: [session], config: o.config });
    cleanups.push(() => ctx.dispose());
    const handoff: Handoff = {
      id: 'h1', sessionId: 'claude:s1', status: 'in_review', summary: 'Weekends excluded', evidence: [], files: [],
      nextSteps: ['merge'], blockers: [], links: [], createdAt: '2026-09-17T09:00:00.000Z',
    };
    const recaps = {
      recap: vi.fn(async () => ({ text: 'Ran tests with ghp_abcdefghijklmnopqrstuvwxyz0123456789', costUsd: 0.01, model: 'claude-haiku-4-5', cached: true })),
      daily: vi.fn(async () => 'Shipped SAF-1787.'),
    };
    const handoffs = {
      latest: vi.fn(() => null),
      generate: vi.fn(async () => handoff),
      toMarkdown: (h: Handoff) => `## Handoff\n${h.summary}`,
    };
    ctx.recaps = recaps as unknown as RecapService;
    ctx.handoffs = handoffs as unknown as HandoffService;
    const secrets = createMemorySecretStore({
      ...(o.linearToken === false ? {} : { 'linear.token': 'lin_api_test_123' }),
      'slack.token': 'xoxp-test-123456',
    });
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    const share = createShareService({ ctx, linear, slack });
    const app = p6TestApp();
    registerShareRoutes(app, ctx, { share, linear });
    return { ctx, audit, app, linearApi, slackApi, recaps, handoffs };
  }

  it('previews a redacted Linear recap comment, then posts the confirmed text', async () => {
    const s = setup();
    const first = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', { source: { kind: 'recap', sessionPk: 'claude:s1' } });
    expect(first.status).toBe(409);
    const body = (await first.json()) as ErrBody;
    expect(body.error.details?.summary).toContain('SAF-1787');
    expect(body.error.details?.preview).toBe('**Session recap — SAF-1787 SLA weekends**\n\nRan tests with «redacted:github»');
    expect(s.linearApi.comments).toEqual([]);

    const ok = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', {
      source: { kind: 'text', text: body.error.details?.preview },
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(s.linearApi.comments).toEqual([{ issueId: 'id-SAF-1787', body: body.error.details?.preview }]);
    expect(s.audit.list({ action: 'linear.comment' })[0]).toMatchObject({ actor: 'user', target: 'SAF-1787', result: 'ok' });
  });

  it('uses the handoff markdown', async () => {
    const s = setup();
    const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', { source: { kind: 'handoff', sessionPk: 'claude:s1' } });
    expect(((await res.json()) as ErrBody).error.details?.preview).toBe('## Handoff\nWeekends excluded');
    expect(s.handoffs.generate).toHaveBeenCalledWith('claude:s1');
  });

  it('posts the daily update to the configured channel', async () => {
    expect(
      (await send(setup().app, 'POST', '/api/slack/post', { source: { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' } })).status,
    ).toBe(400);
    const s = setup({ config: { connectors: { slack: { dailyChannel: 'C0DAILY01' } } } });
    const src = { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' };
    const preview = ((await (await send(s.app, 'POST', '/api/slack/post', { source: src })).json()) as ErrBody).error.details?.preview;
    expect(preview).toBe('**Daily update — wakecap — 2026-09-17**\n\nShipped SAF-1787.');
    const ok = await send(s.app, 'POST', '/api/slack/post', { source: { kind: 'text', text: preview }, confirm: true });
    expect(ok.status).toBe(200);
    expect(s.slackApi.posts).toEqual([{ channel: 'C0DAILY01', text: preview }]);
    expect(s.audit.list({ action: 'slack.post' })[0]).toMatchObject({ target: 'C0DAILY01', result: 'ok' });
  });

  it('creates a follow-up ticket in the session ticket team, assigned to me', async () => {
    const s = setup();
    const body = { sessionPk: 'claude:s1', title: 'Handle holidays too', description: 'Also DB_PASSWORD=x' };
    const first = await send(s.app, 'POST', '/api/linear/follow-up', body);
    expect(first.status).toBe(409);
    expect(((await first.json()) as ErrBody).error.details?.preview).toContain('DB_PASSWORD=«redacted:secret»');
    const ok = await send(s.app, 'POST', '/api/linear/follow-up', { ...body, confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ identifier: 'SAF-2001', assignee: 'Test User' });
    const created = s.linearApi.created[0];
    expect(created?.teamId).toBe('team-saf');
    expect(created?.description).toContain('### Context');
    expect(created?.description).toContain('`claude:s1`');
    expect(created?.description).not.toContain('ghp_');
    expect(s.audit.list({ action: 'linear.issue.create' })[0]?.result).toBe('ok');
  });

  it('only shares plan files from the plan roots', async () => {
    const s = setup();
    const inside = join(s.ctx.paths.claudeHome, 'plans', 'sla.md');
    mkdirSync(join(s.ctx.paths.claudeHome, 'plans'), { recursive: true });
    writeFileSync(inside, '# Plan\n1. exclude weekends\n');
    const outside = join(s.ctx.paths.orcHome, 'secret.md');
    writeFileSync(outside, 'nope');
    const bad = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', { source: { kind: 'plan', planPath: outside } });
    expect(bad.status).toBe(403);
    const good = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', { source: { kind: 'plan', planPath: inside } });
    expect(((await good.json()) as ErrBody).error.details?.preview).toBe('# Plan\n1. exclude weekends');
  });

  it('maps connector failures and audits them', async () => {
    const s = setup({ linearToken: false });
    const res = await send(s.app, 'POST', '/api/linear/issues/SAF-1787/comment', { source: { kind: 'text', text: 'hi' }, confirm: true });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrBody).error.code).toBe('unauthenticated');
    expect(s.audit.list({ action: 'linear.comment' })[0]?.result).toBe('error');
  });

  it('looks up issues and validates identifiers', async () => {
    const s = setup();
    expect(await (await send(s.app, 'GET', '/api/linear/issues/SAF-1787')).json()).toMatchObject({ title: 'Title of SAF-1787' });
    expect((await send(s.app, 'GET', '/api/linear/issues/SAF-404')).status).toBe(404);
    expect((await send(s.app, 'GET', '/api/linear/issues/not-an-id')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/http/routes/share.test.ts`
Expected: FAIL, `registerShareRoutes` / `createShareService` not found

- [ ] **Step 3: Implement the service**

`apps/daemon/src/services/share/share.ts`
```ts
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { LinearIssue, ShareSource } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { toServiceError } from '../../connectors/errors.ts';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import { type Who, need } from '../../http/p6-util.ts';
import { audited } from '../audit/audit.ts';
import { ServiceError } from '../errors.ts';

export type { ShareSource };
export const MAX_SHARE_CHARS = 20_000;

export interface ShareService {
  compose(src: ShareSource): Promise<string>;
  commentOnLinear(identifier: string, body: string, who: Who): Promise<void>;
  createFollowUp(
    i: { sessionPk: string; teamKey: string; title: string; description: string; includeRecap: boolean },
    who: Who,
  ): Promise<LinearIssue>;
  postToSlack(channel: string, text: string, who: Who): Promise<{ ts: string }>;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

async function orThrowService<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toServiceError(e);
  }
}

export function createShareService(d: { ctx: DaemonContext; linear: LinearConnector; slack: SlackConnector }): ShareService {
  const { ctx } = d;
  const preview = (s: string) => redact(s).slice(0, 300);

  function sessionOf(pk: string) {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
    return s;
  }

  async function planText(planPath: string): Promise<string> {
    if (!isAbsolute(planPath) || !planPath.endsWith('.md')) {
      throw new ServiceError('forbidden', 403, 'plan path must be an absolute .md path');
    }
    let real: string;
    try {
      real = await realpath(planPath);
    } catch {
      throw new ServiceError('not_found', 404, 'plan file not found');
    }
    const roots = [
      join(ctx.paths.claudeHome, 'plans'),
      ...ctx.config().links.planRoots.map((r) => expandHome(r, ctx.paths.userHome)),
    ];
    const realRoots = await Promise.all(
      roots.map(async (r) => {
        try {
          return await realpath(r);
        } catch {
          return null;
        }
      }),
    );
    if (!realRoots.some((r) => r !== null && real.startsWith(r + sep))) {
      throw new ServiceError('forbidden', 403, 'plan path is outside the plan roots');
    }
    return readFile(real, 'utf8');
  }

  async function compose(src: ShareSource): Promise<string> {
    let text: string;
    switch (src.kind) {
      case 'recap': {
        const s = sessionOf(src.sessionPk);
        const r = await need(ctx.recaps, 'recaps').recap(src.sessionPk, { onDemand: true });
        text = `**Session recap — ${s.name ?? src.sessionPk}**\n\n${r.text}`;
        break;
      }
      case 'handoff': {
        sessionOf(src.sessionPk);
        const handoffs = need(ctx.handoffs, 'handoffs');
        const h = handoffs.latest(src.sessionPk) ?? (await handoffs.generate(src.sessionPk));
        text = handoffs.toMarkdown(h);
        break;
      }
      case 'plan':
        text = await planText(src.planPath);
        break;
      case 'daily': {
        const body = await need(ctx.recaps, 'recaps').daily(src.projectId, src.date);
        text = `**Daily update — ${src.projectId} — ${src.date}**\n\n${body}`;
        break;
      }
      case 'text':
        text = src.text;
        break;
    }
    const safe = redact(text).trim();
    if (!safe) throw new ServiceError('validation_failed', 400, 'nothing to share');
    return safe.length > MAX_SHARE_CHARS ? `${safe.slice(0, MAX_SHARE_CHARS)}\n\n…(truncated)` : safe;
  }

  return {
    compose,
    async commentOnLinear(identifier, body, who) {
      const audit = need(ctx.audit, 'audit');
      await audited(
        audit,
        { ...who, action: 'linear.comment', target: identifier, params: { chars: body.length, preview: preview(body) } },
        () => orThrowService(() => d.linear.comment(identifier, body)),
      );
    },
    async createFollowUp(i, who) {
      const audit = need(ctx.audit, 'audit');
      const s = sessionOf(i.sessionPk);
      let description = i.description.trim();
      if (i.includeRecap && ctx.recaps) {
        try {
          const r = await ctx.recaps.recap(i.sessionPk, { onDemand: false });
          description = `${description}\n\n### Context\n${r.text}`.trim();
        } catch (err) {
          ctx.log.warn({ err: String(err), sessionPk: i.sessionPk }, 'follow-up recap failed; continuing without it');
        }
      }
      const related = s.tickets.length > 0 ? `, related: ${s.tickets.join(', ')}` : '';
      description = `${description}\n\n---\nFollow-up from Orchestrator session “${s.name ?? i.sessionPk}” (\`${i.sessionPk}\`)${related}.`.trim();
      return audited(
        audit,
        { ...who, action: 'linear.issue.create', target: i.teamKey, params: { title: preview(i.title), sessionPk: i.sessionPk } },
        () =>
          orThrowService(() =>
            d.linear.createIssue({ teamKey: i.teamKey, title: i.title, description: redact(description), assignToMe: true }),
          ),
      );
    },
    async postToSlack(channel, text, who) {
      const audit = need(ctx.audit, 'audit');
      return audited(
        audit,
        { ...who, action: 'slack.post', target: channel, params: { chars: text.length, preview: preview(text) } },
        () => orThrowService(() => d.slack.post(channel, text)),
      );
    },
  };
}
```

- [ ] **Step 4: Implement the routes**

`apps/daemon/src/http/routes/share.ts`
```ts
import { LINEAR_IDENTIFIER_RE, LinearCommentBody, LinearFollowUpBody, SlackPostBody } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { toServiceError } from '../../connectors/errors.ts';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import { ServiceError } from '../../services/errors.ts';
import type { ShareService } from '../../services/share/share.ts';
import { readJson } from '../json.ts';
import { confirmOr409, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

function identifierParam(raw: string): string {
  const id = decodeURIComponent(raw).trim().toUpperCase();
  if (!LINEAR_IDENTIFIER_RE.test(id)) throw new ServiceError('validation_failed', 400, `not a Linear identifier: ${raw}`);
  return id;
}

export function registerShareRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  d: { share: ShareService; linear: LinearConnector },
): void {
  app.get('/api/linear/issues/:identifier', async (c) => {
    const id = identifierParam(c.req.param('identifier'));
    let issue: Awaited<ReturnType<LinearConnector['issue']>>;
    try {
      issue = await d.linear.issue(id);
    } catch (e) {
      throw toServiceError(e);
    }
    if (!issue) throw new ServiceError('not_found', 404, `Linear issue ${id} not found`);
    return c.json(issue);
  });

  app.post('/api/linear/issues/:identifier/comment', async (c) => {
    const id = identifierParam(c.req.param('identifier'));
    const body = await readJson(c, LinearCommentBody);
    const text = await d.share.compose(body.source);
    confirmOr409(body.confirm, `Post this comment on ${id} in Linear as you?`, { preview: text, target: id });
    await d.share.commentOnLinear(id, text, whoOf(c));
    return c.json({ ok: true as const });
  });

  app.post('/api/linear/follow-up', async (c) => {
    const body = await readJson(c, LinearFollowUpBody);
    const firstTicket = ctx.sessions.getByPk(body.sessionPk)?.tickets[0] ?? null;
    const teamKey = body.teamKey ?? ctx.config().connectors.linear.defaultTeamKey ?? firstTicket?.split('-')[0] ?? null;
    if (!teamKey) throw new ServiceError('validation_failed', 400, 'choose a Linear team (teamKey)');
    confirmOr409(body.confirm, `Create a Linear issue in ${teamKey} as you, assigned to you?`, {
      preview: redact(`${body.title}\n\n${body.description}`.trim()),
      teamKey,
    });
    const issue = await d.share.createFollowUp(
      { sessionPk: body.sessionPk, teamKey, title: body.title, description: body.description, includeRecap: body.includeRecap },
      whoOf(c),
    );
    return c.json(issue);
  });

  app.post('/api/slack/post', async (c) => {
    const body = await readJson(c, SlackPostBody);
    const channel = body.channel ?? ctx.config().connectors.slack.dailyChannel;
    if (!channel) {
      throw new ServiceError('validation_failed', 400, 'no channel given and connectors.slack.dailyChannel is not set');
    }
    const text = await d.share.compose(body.source);
    confirmOr409(body.confirm, `Post this to Slack channel ${channel} as you?`, { preview: text, channel });
    return c.json(await d.share.postToSlack(channel, text, whoOf(c)));
  });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/http/routes/share.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add confirmed, redacted and audited Linear and Slack sharing"
```

---

### Task 10: Pollers — Linear assigned-to-me, Slack mentions, stream title enrichment

**Files:**
- Create: `apps/daemon/src/connectors/linear/assigned-poller.ts`, `apps/daemon/src/connectors/slack/mention-poller.ts`, `apps/daemon/src/connectors/stream-enricher.ts`
- Create: `apps/daemon/src/connectors/pollers.test.ts`

**Interfaces:**
- Consumes:
  - `LinearConnector`, `SlackConnector`, `ConnectorError`
  - repo functions `getConnectorMeta`, `setConnectorCursor`, `setConnectorStatus` (Task 3)
  - `slackTsFromDate` (Task 6)
  - `BusEvent` additions (Task 2)
  - P5 `ctx.streams.list({})` and the P5 `streams` Drizzle table (`ticket`, `title`)
- Produces:
  ```ts
  export interface PollerHandle { tick(): Promise<void>; start(): void; stop(): void }
  // connectors/linear/assigned-poller.ts
  export function createLinearAssignedPoller(d: { ctx: DaemonContext; linear: LinearConnector; now?: () => Date }): PollerHandle
  // connectors/slack/mention-poller.ts
  export function createSlackMentionPoller(d: { ctx: DaemonContext; slack: SlackConnector; now?: () => Date }): PollerHandle
  // connectors/stream-enricher.ts
  export interface StreamTitleStore { list(): Array<{ ticket: string; title: string | null }>; setTitle(ticket: string, title: string): void }
  export function createStreamTitleStore(ctx: DaemonContext): StreamTitleStore
  export function createStreamEnricher(d: { ctx: DaemonContext; linear: LinearConnector; store: StreamTitleStore; maxPerTick?: number; intervalMs?: number }): PollerHandle
  ```
  `PollerHandle` is exported from `assigned-poller.ts` and re-used by the others.
- Behaviour:
  - A poller does nothing unless its connector is enabled in config **and** has a metadata row.
  - **Linear:**
    - The first successful poll seeds the cursor silently.
    - Later polls emit `linear.issueChanged` with `before: null` for newly assigned issues, and with `before`/`after` when the title, state, assignee or labels change.
    - The cursor lives in `connector_tokens_meta.cursor_json.assigned` (a map of issue id → fingerprint and issue). Updates merge into the existing cursor, keeping keys such as `tokenExpiresAt`.
  - **Slack:**
    - The first poll sets `mentionsSinceTs` to now.
    - Later polls emit `slack.mention` with **redacted** text, oldest first, and advance the cursor.
  - **Errors:** a failed poll sets `last_status` (`unauthenticated` or `error`), logs a warning, and keeps the cursor.
  - **Overlap:** ticks never overlap. `start()` runs a tick right away and then every `pollSeconds` (the timer is `unref`'d).
  - **Enricher:** every 5 min, it fills in the titles of up to 20 streams whose `title` is null, from `linear.issue(ticket)`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/connectors/pollers.test.ts`
```ts
import type { BusEvent } from '../live/event-bus.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeLinearApi, fakeSlackApi, linearIssue } from '../../test/p6-connector-fakes.ts';
import { p6Context } from '../../test/p6-fakes.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { getConnectorMeta, setConnectorCursor, upsertConnectorMeta } from '../db/repos/connectors.ts';
import { createMemorySecretStore } from '../services/secrets/secret-store.ts';
import { createLinearAssignedPoller } from './linear/assigned-poller.ts';
import { createLinearConnector } from './linear/linear.ts';
import { createSlackMentionPoller } from './slack/mention-poller.ts';
import { createSlackConnector } from './slack/slack.ts';
import { type StreamTitleStore, createStreamEnricher } from './stream-enricher.ts';

const T = '2026-09-17T10:00:00.000Z';

describe('connector pollers', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup() {
    const { ctx } = p6Context();
    cleanups.push(() => ctx.dispose());
    const events: BusEvent[] = [];
    ctx.bus.on('linear.issueChanged', (e) => events.push(e));
    ctx.bus.on('slack.mention', (e) => events.push(e));
    const secrets = createMemorySecretStore({ 'linear.token': 'lin_api_test_123', 'slack.token': 'xoxp-test-123456' });
    const linearApi = fakeLinearApi();
    const slackApi = fakeSlackApi();
    const linear = createLinearConnector({ secrets, api: () => linearApi, cacheTtlMs: 0 });
    const slack = createSlackConnector({ secrets, api: () => slackApi });
    return { ctx, events, linearApi, slackApi, linear, slack };
  }

  it('does nothing until Linear is connected', async () => {
    const s = setup();
    s.linearApi.assigned.push(linearIssue('SAF-1'));
    await createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear }).tick();
    expect(s.events).toEqual([]);
  });

  it('seeds silently, then emits new and changed assigned issues, keeping other cursor keys', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, { connector: 'linear', authKind: 'api_key', accountId: 'user-1', accountLabel: 'me', scopes: [], connectedAt: T });
    setConnectorCursor(s.ctx.db, 'linear', { tokenExpiresAt: '2026-09-18T00:00:00.000Z' });
    const poller = createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear });
    s.linearApi.assigned.push(linearIssue('SAF-1'));
    await poller.tick();
    expect(s.events).toEqual([]);

    s.linearApi.assigned.push(linearIssue('SAF-2'));
    s.linearApi.assigned[0] = linearIssue('SAF-1', { state: 'In Review' });
    await poller.tick();
    expect(s.events).toEqual([
      { type: 'linear.issueChanged', before: expect.objectContaining({ identifier: 'SAF-1', state: 'In Progress' }), after: expect.objectContaining({ state: 'In Review' }) },
      { type: 'linear.issueChanged', before: null, after: expect.objectContaining({ identifier: 'SAF-2' }) },
    ]);
    await poller.tick();
    expect(s.events).toHaveLength(2);
    expect(getConnectorMeta(s.ctx.db, 'linear')?.cursor.tokenExpiresAt).toBe('2026-09-18T00:00:00.000Z');
  });

  it('records auth failures without moving the cursor', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, { connector: 'linear', authKind: 'api_key', accountId: 'user-1', accountLabel: 'me', scopes: [], connectedAt: T });
    s.linearApi.control.failAuth = true;
    s.linearApi.assignedIssues = async () => {
      throw Object.assign(new Error('auth'), { type: 'AuthenticationError' });
    };
    await createLinearAssignedPoller({ ctx: s.ctx, linear: s.linear }).tick();
    expect(getConnectorMeta(s.ctx.db, 'linear')).toMatchObject({ lastStatus: 'unauthenticated', cursor: {} });
  });

  it('seeds the Slack mention cursor, then emits redacted mentions in order', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, { connector: 'slack', authKind: 'user_token', accountId: 'U-ME', accountLabel: 'me', scopes: [], connectedAt: T });
    const poller = createSlackMentionPoller({ ctx: s.ctx, slack: s.slack, now: () => new Date(1758100000000) });
    await poller.tick();
    expect(getConnectorMeta(s.ctx.db, 'slack')?.cursor.mentionsSinceTs).toBe('1758100000.000000');
    s.slackApi.search.push(
      { channel: 'C1', ts: '1758100005.000000', text: '<@U-ME> second password=abc' },
      { channel: 'C1', ts: '1758100001.000000', text: '<@U-ME> first' },
    );
    await poller.tick();
    expect(s.events).toEqual([
      { type: 'slack.mention', channel: 'C1', ts: '1758100001.000000', text: '<@U-ME> first' },
      { type: 'slack.mention', channel: 'C1', ts: '1758100005.000000', text: '<@U-ME> second password=«redacted:secret»' },
    ]);
    await poller.tick();
    expect(s.events).toHaveLength(2);
    expect(getConnectorMeta(s.ctx.db, 'slack')?.cursor.mentionsSinceTs).toBe('1758100005.000000');
  });

  it('fills missing stream titles from Linear', async () => {
    const s = setup();
    upsertConnectorMeta(s.ctx.db, { connector: 'linear', authKind: 'api_key', accountId: 'user-1', accountLabel: 'me', scopes: [], connectedAt: T });
    const rows = [
      { ticket: 'SAF-1787', title: null as string | null },
      { ticket: 'SAF-404', title: null as string | null },
      { ticket: 'SAF-1', title: 'Already set' as string | null },
    ];
    const store: StreamTitleStore = {
      list: () => rows,
      setTitle: (ticket, title) => {
        const r = rows.find((x) => x.ticket === ticket);
        if (r) r.title = title;
      },
    };
    await createStreamEnricher({ ctx: s.ctx, linear: s.linear, store }).tick();
    expect(rows).toEqual([
      { ticket: 'SAF-1787', title: 'Title of SAF-1787' },
      { ticket: 'SAF-404', title: null },
      { ticket: 'SAF-1', title: 'Already set' },
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/connectors/pollers.test.ts`
Expected: FAIL, `Cannot find module './linear/assigned-poller.ts'`

- [ ] **Step 3: Implement the pollers**

`apps/daemon/src/connectors/linear/assigned-poller.ts`
```ts
import type { LinearIssue } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { getConnectorMeta, setConnectorCursor, setConnectorStatus } from '../../db/repos/connectors.ts';
import { ConnectorError } from '../errors.ts';
import type { LinearConnector } from './linear.ts';

export interface PollerHandle {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

type Seen = Record<string, { fp: string; issue: LinearIssue }>;

const fingerprint = (i: LinearIssue) => JSON.stringify([i.title, i.state, i.assignee, [...i.labels].sort()]);

export function createLinearAssignedPoller(d: { ctx: DaemonContext; linear: LinearConnector; now?: () => Date }): PollerHandle {
  const { ctx } = d;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const meta = getConnectorMeta(ctx.db, 'linear');
      if (!ctx.config().connectors.linear.enabled || !meta) return;
      const at = (d.now ? d.now() : new Date()).toISOString();
      let issues: LinearIssue[];
      try {
        issues = await d.linear.assignedToMe();
      } catch (e) {
        const status = e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
        setConnectorStatus(ctx.db, 'linear', status, at);
        ctx.log.warn({ err: String(e) }, 'linear assigned-to-me poll failed');
        return;
      }
      setConnectorStatus(ctx.db, 'linear', 'ok', at);
      const prev = (meta.cursor.assigned ?? null) as Seen | null;
      const next: Seen = {};
      for (const issue of issues) {
        const fp = fingerprint(issue);
        next[issue.id] = { fp, issue };
        if (prev === null) continue;
        const before = prev[issue.id];
        if (!before) ctx.bus.emit({ type: 'linear.issueChanged', before: null, after: issue });
        else if (before.fp !== fp) ctx.bus.emit({ type: 'linear.issueChanged', before: before.issue, after: issue });
      }
      setConnectorCursor(ctx.db, 'linear', { ...meta.cursor, assigned: next });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), ctx.config().connectors.linear.pollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

`apps/daemon/src/connectors/slack/mention-poller.ts`
```ts
import { redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getConnectorMeta, setConnectorCursor, setConnectorStatus } from '../../db/repos/connectors.ts';
import { ConnectorError } from '../errors.ts';
import type { PollerHandle } from '../linear/assigned-poller.ts';
import type { SlackConnector } from './slack.ts';
import { slackTsFromDate } from './text.ts';

export function createSlackMentionPoller(d: { ctx: DaemonContext; slack: SlackConnector; now?: () => Date }): PollerHandle {
  const { ctx } = d;
  const now = () => (d.now ? d.now() : new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const meta = getConnectorMeta(ctx.db, 'slack');
      if (!ctx.config().connectors.slack.enabled || !meta) return;
      const since = typeof meta.cursor.mentionsSinceTs === 'string' ? meta.cursor.mentionsSinceTs : null;
      if (since === null) {
        setConnectorCursor(ctx.db, 'slack', { ...meta.cursor, mentionsSinceTs: slackTsFromDate(now()) });
        return;
      }
      let found: Array<{ channel: string; ts: string; text: string }>;
      try {
        found = await d.slack.mentions(since);
      } catch (e) {
        const status = e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
        setConnectorStatus(ctx.db, 'slack', status, now().toISOString());
        ctx.log.warn({ err: String(e) }, 'slack mention poll failed');
        return;
      }
      setConnectorStatus(ctx.db, 'slack', 'ok', now().toISOString());
      let cursor = since;
      for (const m of found) {
        ctx.bus.emit({ type: 'slack.mention', channel: m.channel, ts: m.ts, text: redact(m.text) });
        cursor = m.ts;
      }
      if (cursor !== since) setConnectorCursor(ctx.db, 'slack', { ...meta.cursor, mentionsSinceTs: cursor });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), ctx.config().connectors.slack.pollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

`apps/daemon/src/connectors/stream-enricher.ts`
```ts
import { eq } from 'drizzle-orm';
import type { DaemonContext } from '../context.ts';
import { getConnectorMeta } from '../db/repos/connectors.ts';
import { streams } from '../db/schema.ts';
import { need } from '../http/p6-util.ts';
import type { PollerHandle } from './linear/assigned-poller.ts';
import type { LinearConnector } from './linear/linear.ts';

export interface StreamTitleStore {
  list(): Array<{ ticket: string; title: string | null }>;
  setTitle(ticket: string, title: string): void;
}

export function createStreamTitleStore(ctx: DaemonContext): StreamTitleStore {
  return {
    list: () => need(ctx.streams, 'streams').list({}).map((s) => ({ ticket: s.ticket, title: s.title })),
    setTitle: (ticket, title) => {
      ctx.db.update(streams).set({ title }).where(eq(streams.ticket, ticket)).run();
    },
  };
}

export function createStreamEnricher(d: {
  ctx: DaemonContext;
  linear: LinearConnector;
  store: StreamTitleStore;
  maxPerTick?: number;
  intervalMs?: number;
}): PollerHandle {
  const max = d.maxPerTick ?? 20;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!d.ctx.config().connectors.linear.enabled || !getConnectorMeta(d.ctx.db, 'linear')) return;
      const missing = d.store.list().filter((s) => s.title === null).slice(0, max);
      for (const s of missing) {
        try {
          const issue = await d.linear.issue(s.ticket);
          if (issue) d.store.setTitle(s.ticket, issue.title);
        } catch (err) {
          d.ctx.log.warn({ err: String(err), ticket: s.ticket }, 'stream enrichment failed');
          return;
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), d.intervalMs ?? 5 * 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/connectors/pollers.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add Linear assigned, Slack mention and stream title pollers"
```

---

### Task 11: Web — Linear issue chip, share dialogs, follow-up dialog, daily update button

**Files:**
- Create: `apps/web/src/api/queries/linear.ts`
- Create: `apps/web/src/features/linear/LinearIssueChip.tsx`
- Create: `apps/web/src/features/share/ShareDialog.tsx`, `apps/web/src/features/share/FollowUpDialog.tsx`, `apps/web/src/features/share/SessionShareActions.tsx`, `apps/web/src/features/share/DailyUpdateButton.tsx`, `apps/web/src/features/share/share.test.tsx`
- Modify: `apps/web/src/features/session-detail/SessionHeader.tsx`, `apps/web/src/features/streams/StreamHeader.tsx`, `apps/web/src/features/inbox/InboxPage.tsx`

**Interfaces:**
- Consumes:
  - client methods `linearIssue`, `linearComment`, `linearFollowUp`, `slackPost`; `isApiErrorWithCode` (Task 2)
  - `Session`, `WorkStream` (core); `sessionPk` string format `${source}:${id}`
  - `useProjectStore` (P1); `Button` (UI kit)
- Produces:
  ```ts
  export function useLinearIssue(identifier: string | null): UseQueryResult<LinearIssue>     // key ['linear-issue', identifier], staleTime 10 min, retry false
  export function LinearIssueChip(props: { identifier: string }): JSX.Element | null
  export type ShareTarget = { kind: 'linear-comment'; identifier?: string } | { kind: 'slack-post'; channel?: string };
  export function ShareDialog(props: { title: string; target: ShareTarget; source: ShareSource; onClose(): void }): JSX.Element
  export function FollowUpDialog(props: { sessionPk: string; defaultTitle: string; onClose(): void }): JSX.Element
  export function SessionShareActions(props: { session: Session }): JSX.Element
  export function DailyUpdateButton(): JSX.Element
  export function todayLocal(d?: Date): string        // YYYY-MM-DD in local time
  ```
- Behaviour: "Preview" calls the route without `confirm`. On `confirmation_required`, the dialog shows `details.summary` and `details.preview`. "Confirm and post" re-sends `{ kind: 'text', text: preview }` with `confirm: true`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/share/share.test.tsx`
```tsx
import type { LinearIssue } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { LinearIssueChip } from '../linear/LinearIssueChip.tsx';
import { FollowUpDialog } from './FollowUpDialog.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { todayLocal } from './DailyUpdateButton.tsx';

const confirmError = (preview: string) =>
  Object.assign(new Error('confirm to continue'), {
    status: 409,
    code: 'confirmation_required',
    details: { summary: 'Post this comment on SAF-1787 in Linear as you?', preview },
  });

const issue: LinearIssue = {
  id: 'i1', identifier: 'SAF-1787', title: 'Exclude weekends', state: 'In Review', assignee: 'Test User',
  url: 'https://linear.app/example/issue/SAF-1787', labels: [],
};

describe('share UI', () => {
  afterEach(() => setApiClientForTests(null));

  it('previews, then posts exactly the previewed text to Linear', async () => {
    const linearComment = vi
      .fn()
      .mockRejectedValueOnce(confirmError('**Session recap**\n\nDone.'))
      .mockResolvedValueOnce({ ok: true });
    setApiClientForTests(fakeApi({ linearComment }));
    const onClose = vi.fn();
    renderWithClient(
      <ShareDialog
        title="Recap to Linear"
        target={{ kind: 'linear-comment', identifier: 'SAF-1787' }}
        source={{ kind: 'recap', sessionPk: 'claude:s1' }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Post this comment on SAF-1787 in Linear as you?')).toBeTruthy();
    expect(screen.getByTestId('share-preview').textContent).toBe('**Session recap**\n\nDone.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and post' }));
    await waitFor(() => expect(screen.getByText('Posted.')).toBeTruthy());
    expect(linearComment.mock.calls).toEqual([
      ['SAF-1787', { kind: 'recap', sessionPk: 'claude:s1' }, false],
      ['SAF-1787', { kind: 'text', text: '**Session recap**\n\nDone.' }, true],
    ]);
  });

  it('shows non-confirmation errors', async () => {
    const slackPost = vi.fn().mockRejectedValue(Object.assign(new Error('Slack is not connected'), { code: 'unauthenticated' }));
    setApiClientForTests(fakeApi({ slackPost }));
    renderWithClient(
      <ShareDialog title="Daily update" target={{ kind: 'slack-post' }} source={{ kind: 'daily', projectId: 'wakecap', date: '2026-09-17' }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Slack is not connected');
    expect(slackPost).toHaveBeenCalledWith({ channel: undefined, source: { kind: 'daily', projectId: 'wakecap', date: '2026-09-17' }, confirm: false });
  });

  it('creates a follow-up ticket after confirmation', async () => {
    const linearFollowUp = vi
      .fn()
      .mockRejectedValueOnce(confirmError('Handle holidays'))
      .mockResolvedValueOnce({ ...issue, identifier: 'SAF-2001', url: 'https://linear.app/example/issue/SAF-2001' });
    setApiClientForTests(fakeApi({ linearFollowUp }));
    renderWithClient(<FollowUpDialog sessionPk="claude:s1" defaultTitle="Handle holidays" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByRole('link', { name: 'SAF-2001' })).toBeTruthy();
    expect(linearFollowUp.mock.calls[1]?.[0]).toEqual({
      sessionPk: 'claude:s1', title: 'Handle holidays', description: '', teamKey: undefined, includeRecap: true, confirm: true,
    });
  });

  it('renders the Linear chip only when the issue loads', async () => {
    setApiClientForTests(fakeApi({ linearIssue: async () => issue }));
    renderWithClient(<LinearIssueChip identifier="SAF-1787" />);
    const link = await screen.findByRole('link');
    expect(link.textContent).toBe('SAF-1787 · In Review · Test User');
    expect(link.getAttribute('href')).toBe(issue.url);
  });

  it('formats the local date', () => {
    expect(todayLocal(new Date(2026, 8, 7, 23, 30))).toBe('2026-09-07');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/features/share`
Expected: FAIL, `Cannot find module './ShareDialog.tsx'`

- [ ] **Step 3: Implement the hook and the components**

`apps/web/src/api/queries/linear.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useLinearIssue(identifier: string | null) {
  return useQuery({
    queryKey: ['linear-issue', identifier],
    queryFn: () => getApiClient().linearIssue(identifier ?? ''),
    enabled: identifier !== null && identifier !== '',
    staleTime: 10 * 60_000,
    retry: false,
  });
}
```

`apps/web/src/features/linear/LinearIssueChip.tsx`
```tsx
import { useLinearIssue } from '../../api/queries/linear.ts';

export function LinearIssueChip({ identifier }: { identifier: string }) {
  const { data } = useLinearIssue(identifier);
  if (!data) return null;
  const label = [data.identifier, data.state, data.assignee].filter((x): x is string => Boolean(x)).join(' · ');
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noreferrer"
      title={data.title}
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs hover:bg-black/5"
    >
      {label}
    </a>
  );
}
```

`apps/web/src/features/share/ShareDialog.tsx`
```tsx
import { type ShareSource, isApiErrorWithCode } from '@orc/api-contract';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getApiClient } from '../../api/client.ts';

export type ShareTarget = { kind: 'linear-comment'; identifier?: string } | { kind: 'slack-post'; channel?: string };

type Phase = 'edit' | 'preview' | 'sending' | 'done';

export function readConfirmation(e: unknown): { summary: string; preview: string } | null {
  if (!isApiErrorWithCode(e, 'confirmation_required')) return null;
  const d = (e.details ?? {}) as { summary?: unknown; preview?: unknown };
  return { summary: typeof d.summary === 'string' ? d.summary : '', preview: typeof d.preview === 'string' ? d.preview : '' };
}

export function ShareDialog({
  title,
  target,
  source,
  onClose,
}: { title: string; target: ShareTarget; source: ShareSource; onClose(): void }) {
  const [identifier, setIdentifier] = useState(target.kind === 'linear-comment' ? (target.identifier ?? '') : '');
  const [channel, setChannel] = useState(target.kind === 'slack-post' ? (target.channel ?? '') : '');
  const [phase, setPhase] = useState<Phase>('edit');
  const [summary, setSummary] = useState('');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = (src: ShareSource, confirm: boolean) => {
    const api = getApiClient();
    if (target.kind === 'linear-comment') return api.linearComment(identifier.trim().toUpperCase(), src, confirm);
    return api.slackPost({ channel: channel.trim() === '' ? undefined : channel.trim(), source: src, confirm });
  };

  async function onPreview() {
    setError(null);
    try {
      await send(source, false);
      setPhase('done');
    } catch (e) {
      const c = readConfirmation(e);
      if (c) {
        setSummary(c.summary);
        setPreview(c.preview);
        setPhase('preview');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function onConfirm() {
    setError(null);
    setPhase('sending');
    try {
      await send({ kind: 'text', text: preview }, true);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('preview');
    }
  }

  return (
    <div role="dialog" aria-label={title} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center">
      <div className="w-full max-w-xl space-y-3 rounded-lg bg-white p-4 text-sm shadow-xl dark:bg-neutral-900">
        <h2 className="text-base font-semibold">{title}</h2>
        {phase === 'edit' && (
          <div className="space-y-2">
            {target.kind === 'linear-comment' ? (
              <label className="block">
                Linear issue
                <input className="mt-1 w-full rounded border px-2 py-1" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="SAF-1787" />
              </label>
            ) : (
              <label className="block">
                Slack channel ID (empty = daily channel)
                <input className="mt-1 w-full rounded border px-2 py-1" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123ABCD" />
              </label>
            )}
            <Button onClick={onPreview} disabled={target.kind === 'linear-comment' && identifier.trim() === ''}>
              Preview
            </Button>
          </div>
        )}
        {(phase === 'preview' || phase === 'sending') && (
          <div className="space-y-2">
            <p className="font-medium">{summary}</p>
            <pre data-testid="share-preview" className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-black/5 p-2">
              {preview}
            </pre>
            <p className="text-xs opacity-70">Secrets were redacted. This is posted as you.</p>
            <Button onClick={onConfirm} disabled={phase === 'sending'}>
              Confirm and post
            </Button>
          </div>
        )}
        {phase === 'done' && <p>Posted.</p>}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/features/share/FollowUpDialog.tsx`
```tsx
import type { LinearIssue } from '@orc/api-contract';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getApiClient } from '../../api/client.ts';
import { readConfirmation } from './ShareDialog.tsx';

export function FollowUpDialog({ sessionPk, defaultTitle, onClose }: { sessionPk: string; defaultTitle: string; onClose(): void }) {
  const [title, setTitle] = useState(defaultTitle);
  const [teamKey, setTeamKey] = useState('');
  const [description, setDescription] = useState('');
  const [includeRecap, setIncludeRecap] = useState(true);
  const [confirmation, setConfirmation] = useState<{ summary: string; preview: string } | null>(null);
  const [created, setCreated] = useState<LinearIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const body = (confirm: boolean) => ({
    sessionPk,
    title: title.trim(),
    description,
    teamKey: teamKey.trim() === '' ? undefined : teamKey.trim().toUpperCase(),
    includeRecap,
    confirm,
  });

  async function run(confirm: boolean) {
    setError(null);
    setBusy(true);
    try {
      setCreated(await getApiClient().linearFollowUp(body(confirm)));
    } catch (e) {
      const c = readConfirmation(e);
      if (c && !confirm) setConfirmation(c);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="Create follow-up ticket" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center">
      <div className="w-full max-w-xl space-y-3 rounded-lg bg-white p-4 text-sm shadow-xl dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Create follow-up ticket</h2>
        {created ? (
          <p>
            Created{' '}
            <a href={created.url} target="_blank" rel="noreferrer" className="underline">
              {created.identifier}
            </a>
          </p>
        ) : confirmation ? (
          <div className="space-y-2">
            <p className="font-medium">{confirmation.summary}</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-black/5 p-2">{confirmation.preview}</pre>
            <Button onClick={() => run(true)} disabled={busy}>
              Confirm and create
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block">
              Title
              <input className="mt-1 w-full rounded border px-2 py-1" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="block">
              Team key (optional)
              <input className="mt-1 w-full rounded border px-2 py-1" value={teamKey} onChange={(e) => setTeamKey(e.target.value)} placeholder="SAF" />
            </label>
            <label className="block">
              Description
              <textarea className="mt-1 w-full rounded border px-2 py-1" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeRecap} onChange={(e) => setIncludeRecap(e.target.checked)} />
              Include a session recap as context
            </label>
            <Button onClick={() => run(false)} disabled={busy || title.trim().length < 3}>
              Preview
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/features/share/SessionShareActions.tsx`
```tsx
import type { ShareSource } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FollowUpDialog } from './FollowUpDialog.tsx';
import { ShareDialog, type ShareTarget } from './ShareDialog.tsx';

type Open =
  | { kind: 'share'; title: string; target: ShareTarget; source: ShareSource }
  | { kind: 'follow-up' }
  | null;

export function SessionShareActions({ session }: { session: Session }) {
  const pk = `${session.source}:${session.id}`;
  const ticket = session.tickets[0];
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'share', title: 'Recap to Linear', target: { kind: 'linear-comment', identifier: ticket }, source: { kind: 'recap', sessionPk: pk } })}>
        Recap → Linear
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'share', title: 'Handoff to Linear', target: { kind: 'linear-comment', identifier: ticket }, source: { kind: 'handoff', sessionPk: pk } })}>
        Handoff → Linear
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'share', title: 'Recap to Slack', target: { kind: 'slack-post' }, source: { kind: 'recap', sessionPk: pk } })}>
        Recap → Slack
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'follow-up' })}>
        Follow-up ticket
      </Button>
      {open?.kind === 'share' && <ShareDialog title={open.title} target={open.target} source={open.source} onClose={close} />}
      {open?.kind === 'follow-up' && (
        <FollowUpDialog sessionPk={pk} defaultTitle={`Follow-up: ${session.name ?? ticket ?? 'session'}`} onClose={close} />
      )}
    </div>
  );
}
```

`apps/web/src/features/share/DailyUpdateButton.tsx`
```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '../../stores/project.ts';
import { ShareDialog } from './ShareDialog.tsx';

export function todayLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function DailyUpdateButton() {
  const projectId = useProjectStore((s) => s.projectId);
  const [open, setOpen] = useState(false);
  const target = projectId && projectId !== 'all' ? projectId : 'wakecap';
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Post daily update
      </Button>
      {open && (
        <ShareDialog
          title={`Daily update — ${target}`}
          target={{ kind: 'slack-post' }}
          source={{ kind: 'daily', projectId: target, date: todayLocal() }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Mount the components**

- In `apps/web/src/features/session-detail/SessionHeader.tsx`: add `import { SessionShareActions } from '../share/SessionShareActions.tsx';` and render `<SessionShareActions session={session} />` in the header's action row.
- In `apps/web/src/features/streams/StreamHeader.tsx`: add `import { LinearIssueChip } from '../linear/LinearIssueChip.tsx';` and render `<LinearIssueChip identifier={stream.ticket} />` next to the ticket heading.
- In `apps/web/src/features/inbox/InboxPage.tsx`: add `import { DailyUpdateButton } from '../share/DailyUpdateButton.tsx';` and render `<DailyUpdateButton />` at the right end of the page header.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/share apps/web/src/features/session-detail apps/web/src/features/streams apps/web/src/features/inbox`
Expected: PASS (5 new tests; the existing header, stream and inbox tests still pass. If an existing test uses a strict `fakeApi` and now hits `linearIssue`, stub `linearIssue: async () => Promise.reject(new Error('not connected'))` in that test.)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add Linear chip, share dialogs, follow-up tickets and daily update"
```

---

### Task 12: Remote access core — request classification, Tailscale identity, device pairing, route policy, bootstrap fix, WS check

**Files:**
- Create: `apps/daemon/src/remote/classify.ts`, `apps/daemon/src/remote/devices.ts`, `apps/daemon/src/remote/pairing.ts`, `apps/daemon/src/remote/step-up.ts`, `apps/daemon/src/remote/tailscale.ts`, `apps/daemon/src/remote/remote.test.ts`
- Create: `apps/daemon/src/http/remote-guard.ts`, `apps/daemon/src/http/ws-remote.ts`, `apps/daemon/src/http/routes/remote.ts`
- Create: `apps/daemon/src/http/remote-guard.test.ts`, `apps/daemon/src/http/ws-remote.test.ts`
- Modify: `apps/daemon/src/http/auth.ts` (add `apiAccessMiddleware`, `bootstrapHandler`), `apps/daemon/src/http/app.ts` (use them, mount `remoteGuard`), `apps/daemon/src/http/ws.ts` (call `checkWsUpgrade`)

**Interfaces:**
- Consumes:
  - repo functions for remote devices (Task 3)
  - `RemoteInfo`, `remoteOf`, `requireLoopback`, `confirmOr409`, `need`, `whoOf` (Task 2)
  - `PairBody`, `RemoteConfigBody`, `ConfirmBody` (Task 2)
  - P1 `allowedHosts`, `allowedOrigins`, `tokenMatches`, `isLoopback`, `readJson`, `ServiceError`
  - P2 `ctx.updateConfig`
  - `execa` (contracts §1)
- Produces:
  ```ts
  // remote/classify.ts
  export type HeaderGetter = (name: string) => string | undefined;
  export function isLoopbackAddress(addr: string | null | undefined): boolean
  export function hostnameOf(hostHeader: string | null | undefined): string | null
  export function isRemoteRequest(get: HeaderGetter, remoteAddress: string | null): boolean
  export function loginMatches(given: string | null | undefined, allowed: string | null | undefined): boolean
  export function safeEqual(a: string, b: string): boolean
  // remote/devices.ts
  export const hashToken: (token: string) => string
  export interface DeviceService   // as in Contract additions §11
  export function createDeviceService(db: OrcDb, o?: { now?: () => Date }): DeviceService
  // remote/pairing.ts
  export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  export interface PairingService { create(): { code: string; expiresAt: string }; consume(code: string): boolean; activeUntil(): string | null }
  export function createPairingService(o?: { ttlMs?: () => number; maxFailures?: number; now?: () => number }): PairingService
  // remote/step-up.ts
  export interface StepUpStore   // as in Contract additions §11
  export function createStepUpStore(o: { ttlMs: () => number; now?: () => number }): StepUpStore
  // remote/tailscale.ts
  export type RunCommand = (cmd: string, args: string[]) => Promise<string>;
  export function detectFunnel(status: unknown): boolean
  export function readServeStatus(run?: RunCommand): Promise<unknown>          // null when tailscale is missing
  export interface FunnelWatch { detected(): boolean; refresh(): Promise<boolean>; start(): void; stop(): void }
  export function createFunnelWatch(o?: { run?: RunCommand; intervalMs?: number; log?: { warn(o: object, m?: string): void } }): FunnelWatch
  // http/remote-guard.ts
  export type RemotePolicy = 'public' | 'device' | 'stepup' | 'deny';
  export const REMOTE_RULES: ReadonlyArray<{ method: string; pattern: RegExp; policy: RemotePolicy }>
  export function remotePolicy(method: string, path: string): RemotePolicy
  export interface RemoteGuardDeps { config: () => OrcConfig; devices: DeviceService; stepUp: StepUpStore; funnel: Pick<FunnelWatch, 'detected'> }
  export type RemoteVerdict = { ok: true; remote: RemoteInfo } | { ok: false; status: 401 | 403; code: string; message: string };
  export function evaluateRemote(r: { method: string; path: string; get: HeaderGetter; token: string | null }, d: RemoteGuardDeps): RemoteVerdict
  export function remoteGuard(d: RemoteGuardDeps | null): MiddlewareHandler<OrcEnv>
  // http/ws-remote.ts
  export type WsVerdict = { ok: true; remote: RemoteInfo | null } | { ok: false; status: 401 | 403; code: string };
  export function checkWsUpgrade(req: IncomingMessage, d: RemoteGuardDeps | null): WsVerdict
  // http/auth.ts
  export function apiAccessMiddleware(o: { token: string; port: () => number; env?: NodeJS.ProcessEnv }): MiddlewareHandler<OrcEnv>
  export function bootstrapHandler(o: { token: string; port: () => number; env?: NodeJS.ProcessEnv }): Handler<OrcEnv>
  // http/routes/remote.ts
  export function registerRemoteRoutes(app: OrcApp, ctx: DaemonContext, d: { devices: DeviceService; pairing: PairingService; stepUp: StepUpStore; funnel: FunnelWatch }): void
  ```
- Behaviour:
  - **Classification.** A request is remote when the socket is not loopback, **or** it carries any `Tailscale-User-*`, `X-Forwarded-*` or `Forwarded` header, **or** its Host is not loopback. `tailscale serve` connects from `127.0.0.1`, so the headers decide. Classification errs toward "remote": a local process that forges these headers only gets the stricter remote checks.
  - **Remote checks, in order:**
    1. remote access enabled, with `origin` and `allowedLogin` set → else `403 remote_disabled`
    2. no Tailscale Funnel → else `403 funnel_detected`
    3. `Tailscale-User-Login` equals `allowedLogin` (case-insensitive) → else `403 remote_identity_mismatch`
    4. `X-Forwarded-Host` (or `Host`) equals the origin's hostname → else `403 remote_bad_host`
    5. any `Origin` header equals `remote.origin` → else `403 forbidden`
    6. route policy is not `deny` → else `403 remote_forbidden`
    7. unless the policy is `public`: a valid, non-revoked **device** token (the install token never works here) → else `401 unauthorized`
    8. for `stepup` routes: a valid step-up → else `401 step_up_required`
  - **Tokens.** P1's host, Origin and install-token checks run only for local requests.
  - **Bootstrap.** `/bootstrap.js` returns `window.__ORC_TOKEN__ = null;` to remote requests.
  - **Pairing codes.**
    - 8 characters from an alphabet without look-alikes.
    - One active code at a time, valid for `remote.pairingTtlSec`.
    - Single use. Five wrong attempts cancel the code.
    - Creating a code is loopback-only. Redeeming one is remote-only.
  - **Device tokens.** 32 random bytes, base64url. Only the SHA-256 is stored. `lastSeenAt` is written at most once a minute.
  - **Without deps.** `remoteGuard(null)` marks every request as local. This mode is used only by the P1 tests. `createDaemon` always passes deps (Task 20 asserts this).

- [ ] **Step 1: Write the failing unit tests**

`apps/daemon/src/remote/remote.test.ts`
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrcDb, openDb } from '../db/client.ts';
import { hostnameOf, isRemoteRequest, loginMatches } from './classify.ts';
import { createDeviceService, hashToken } from './devices.ts';
import { PAIRING_ALPHABET, createPairingService } from './pairing.ts';
import { createStepUpStore } from './step-up.ts';
import { createFunnelWatch, detectFunnel } from './tailscale.ts';

const h = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()];

describe('classify', () => {
  it('treats serve-proxied requests as remote even from 127.0.0.1', () => {
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317' }), '127.0.0.1')).toBe(false);
    expect(isRemoteRequest(h({ host: 'localhost:4317' }), '::1')).toBe(false);
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317', 'tailscale-user-login': 'me@example.com' }), '127.0.0.1')).toBe(true);
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317', 'x-forwarded-for': '100.64.0.2' }), '127.0.0.1')).toBe(true);
    expect(isRemoteRequest(h({ host: 'mac.tail1234.ts.net' }), '127.0.0.1')).toBe(true);
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317' }), '100.64.0.2')).toBe(true);
    expect(isRemoteRequest(h({}), null)).toBe(false);
  });

  it('parses hosts and compares logins', () => {
    expect(hostnameOf('mac.tail1234.ts.net:443')).toBe('mac.tail1234.ts.net');
    expect(hostnameOf('[::1]:4317')).toBe('[::1]');
    expect(hostnameOf('a b')).toBeNull();
    expect(loginMatches(' Me@Example.com ', 'me@example.com')).toBe(true);
    expect(loginMatches('', 'me@example.com')).toBe(false);
    expect(loginMatches('me@example.com', null)).toBe(false);
  });
});

describe('pairing', () => {
  it('issues single-use codes that expire and lock after failures', () => {
    let now = 0;
    const p = createPairingService({ ttlMs: () => 1000, maxFailures: 3, now: () => now });
    const { code } = p.create();
    expect(code).toMatch(new RegExp(`^[${PAIRING_ALPHABET}]{8}$`));
    expect(p.consume(code.toLowerCase())).toBe(true);
    expect(p.consume(code)).toBe(false);

    const second = p.create().code;
    now = 1001;
    expect(p.consume(second)).toBe(false);

    now = 2000;
    const third = p.create().code;
    expect(p.activeUntil()).toBe(new Date(3000).toISOString());
    expect(p.consume('AAAAAAAA')).toBe(false);
    expect(p.consume('BBBBBBBB')).toBe(false);
    expect(p.consume('CCCCCCCC')).toBe(false);
    expect(p.consume(third)).toBe(false);
    expect(p.activeUntil()).toBeNull();
  });
});

describe('step-up', () => {
  it('grants per device until the TTL passes', () => {
    let now = 0;
    const s = createStepUpStore({ ttlMs: () => 300_000, now: () => now });
    expect(s.valid('d1')).toBe(false);
    expect(s.grant('d1')).toBe(new Date(300_000).toISOString());
    expect(s.valid('d1')).toBe(true);
    expect(s.valid('d2')).toBe(false);
    now = 300_001;
    expect(s.valid('d1')).toBe(false);
    expect(s.validUntil('d1')).toBeNull();
    s.grant('d1');
    s.revoke('d1');
    expect(s.valid('d1')).toBe(false);
  });
});

describe('devices', () => {
  let dir: string;
  let db: OrcDb;
  let close: () => void;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p6-devices-'));
    ({ db, close } = openDb(join(dir, 'index.db')));
  });
  afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies hashed tokens and rejects revoked or foreign ones', () => {
    const devices = createDeviceService(db);
    const { device, token } = devices.create('Phone', 'me@example.com');
    expect(device.tokenHash).toBe(hashToken(token));
    expect(device.tokenHash).not.toContain(token);
    expect(devices.verify(token)?.id).toBe(device.id);
    expect(devices.verify(null)).toBeNull();
    expect(devices.verify('short')).toBeNull();
    expect(devices.verify('a'.repeat(64))).toBeNull();
    expect(devices.list()[0]).toMatchObject({ id: device.id, credentials: 0 });
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.verify(token)).toBeNull();
  });
});

describe('tailscale funnel detection', () => {
  it('reads AllowFunnel from serve status', async () => {
    expect(detectFunnel({ TCP: { '443': { HTTPS: true } } })).toBe(false);
    expect(detectFunnel({ AllowFunnel: { 'mac.tail1234.ts.net:443': true } })).toBe(true);
    expect(detectFunnel(null)).toBe(false);
    let json = '{"AllowFunnel":{"mac.tail1234.ts.net:443":true}}';
    const watch = createFunnelWatch({ run: async () => json });
    expect(await watch.refresh()).toBe(true);
    expect(watch.detected()).toBe(true);
    json = '{}';
    expect(await watch.refresh()).toBe(false);
    const missing = createFunnelWatch({
      run: async () => {
        throw new Error('spawn tailscale ENOENT');
      },
    });
    expect(await missing.refresh()).toBe(false);
  });
});
```

`apps/daemon/src/http/remote-guard.test.ts`
```ts
import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { p6Context } from '../../test/p6-fakes.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { createDeviceService } from '../remote/devices.ts';
import { createPairingService } from '../remote/pairing.ts';
import { createStepUpStore } from '../remote/step-up.ts';
import { ServiceError } from '../services/errors.ts';
import { apiAccessMiddleware, bootstrapHandler } from './auth.ts';
import { remoteGuard, remotePolicy } from './remote-guard.ts';
import { registerRemoteRoutes } from './routes/remote.ts';
import type { OrcEnv } from './types.ts';

const INSTALL = 'f'.repeat(64);
const ORIGIN = 'https://mac.tail1234.ts.net';
const LOCAL = { host: '127.0.0.1:4317' };
const REMOTE = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'x-forwarded-for': '100.101.102.103',
  'tailscale-user-login': 'me@example.com',
};
const ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
type Err = { error: { code: string } };

describe('remote guard', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(remote: Record<string, unknown> = { enabled: true, origin: ORIGIN, allowedLogin: 'me@example.com' }) {
    const { ctx, audit } = p6Context({ config: { remote } });
    cleanups.push(() => ctx.dispose());
    const devices = createDeviceService(ctx.db);
    const stepUp = createStepUpStore({ ttlMs: () => 300_000 });
    const pairing = createPairingService({ ttlMs: () => 300_000 });
    let funnelOn = false;
    const funnel = { detected: () => funnelOn, refresh: async () => funnelOn, start: () => {}, stop: () => {} };
    const app = new Hono<OrcEnv>();
    app.onError((err, c) =>
      err instanceof ServiceError
        ? c.json(apiError(err.code, err.message, err.details), err.status)
        : c.json(apiError('internal', String(err)), 500),
    );
    app.use('*', remoteGuard({ config: ctx.config, devices, stepUp, funnel }));
    app.use('/api/*', apiAccessMiddleware({ token: INSTALL, port: () => 4317 }));
    app.get('/bootstrap.js', bootstrapHandler({ token: INSTALL, port: () => 4317 }));
    registerRemoteRoutes(app, ctx, { devices, pairing, stepUp, funnel });
    app.get('/api/live', (c) => c.json([]));
    app.delete('/api/pty/:id', (c) => c.json({ killed: c.req.param('id') }));
    app.post('/api/templates/x', (c) => c.json({ wrote: true }));
    const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      app.request(
        `http://127.0.0.1:4317${path}`,
        { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
        ENV,
      );
    const pair = async () => {
      const { code } = (await (await req('POST', '/api/remote/pairing', { ...LOCAL, 'x-orc-token': INSTALL }, {})).json()) as { code: string };
      const res = await req('POST', '/api/remote/pair', REMOTE, { code, name: 'Phone' });
      return (await res.json()) as { deviceId: string; deviceToken: string };
    };
    return { ctx, audit, req, pair, stepUp, setFunnel: (v: boolean) => { funnelOn = v; } };
  }

  it('keeps the local token rules for local requests', async () => {
    const b = build();
    expect((await b.req('GET', '/api/live', { ...LOCAL, 'x-orc-token': INSTALL })).status).toBe(200);
    expect((await b.req('GET', '/api/live', LOCAL)).status).toBe(401);
  });

  it('blocks remote requests when remote access is off or misconfigured', async () => {
    const off = build({ enabled: false });
    const res = await off.req('GET', '/api/live', REMOTE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Err).error.code).toBe('remote_disabled');
    const b = build();
    b.setFunnel(true);
    expect(((await (await b.req('GET', '/api/live', REMOTE)).json()) as Err).error.code).toBe('funnel_detected');
  });

  it('checks identity, host, origin and the device token', async () => {
    const b = build();
    const code = async (headers: Record<string, string>) => ((await (await b.req('GET', '/api/live', headers)).json()) as Err).error.code;
    expect(await code({ ...REMOTE, 'tailscale-user-login': 'someone@example.com' })).toBe('remote_identity_mismatch');
    expect(await code({ ...REMOTE, 'x-forwarded-host': 'evil.example.com' })).toBe('remote_bad_host');
    expect(await code({ ...REMOTE, origin: 'https://evil.example.com' })).toBe('forbidden');
    expect(await code(REMOTE)).toBe('unauthorized');
    expect(await code({ ...REMOTE, 'x-orc-token': INSTALL })).toBe('unauthorized');
  });

  it('pairs a device, then allows reads and denies loopback-only routes', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    expect(deviceToken.length).toBeGreaterThanOrEqual(43);
    expect(b.audit.list({ action: 'remote.pair' })[0]).toMatchObject({ actor: 'remote', target: deviceId, result: 'ok' });
    expect((await b.req('GET', '/api/live', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(200);
    const devices = await b.req('GET', '/api/remote/devices', { ...REMOTE, 'x-orc-token': deviceToken });
    expect(((await devices.json()) as Err).error.code).toBe('remote_forbidden');
    const listed = (await (await b.req('GET', '/api/remote/devices', { ...LOCAL, 'x-orc-token': INSTALL })).json()) as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ id: deviceId, name: 'Phone', login: 'me@example.com', credentials: 0 });
    expect(listed[0]).not.toHaveProperty('tokenHash');
    const write = await b.req('POST', '/api/templates/x', { ...REMOTE, 'x-orc-token': deviceToken }, {});
    expect(((await write.json()) as Err).error.code).toBe('remote_forbidden');
  });

  it('requires step-up for state-changing remote routes', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    const first = await b.req('DELETE', '/api/pty/p1', { ...REMOTE, 'x-orc-token': deviceToken });
    expect(first.status).toBe(401);
    expect(((await first.json()) as Err).error.code).toBe('step_up_required');
    b.stepUp.grant(deviceId);
    expect((await b.req('DELETE', '/api/pty/p1', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(200);
  });

  it('rejects bad pairing attempts', async () => {
    const b = build();
    await b.req('POST', '/api/remote/pairing', { ...LOCAL, 'x-orc-token': INSTALL }, {});
    const wrong = await b.req('POST', '/api/remote/pair', REMOTE, { code: 'ZZZZZZZZ', name: 'Phone' });
    expect(((await wrong.json()) as Err).error.code).toBe('invalid_code');
    expect(b.audit.list({ action: 'remote.pair' })[0]?.result).toBe('denied');
    const local = await b.req('POST', '/api/remote/pair', { ...LOCAL, 'x-orc-token': INSTALL }, { code: 'ZZZZZZZZ', name: 'Mac' });
    expect(((await local.json()) as Err).error.code).toBe('not_remote');
    const remotePairing = await b.req('POST', '/api/remote/pairing', REMOTE, {});
    expect(((await remotePairing.json()) as Err).error.code).toBe('remote_forbidden');
  });

  it('revokes devices from the Mac', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    expect((await b.req('DELETE', `/api/remote/devices/${deviceId}`, { ...LOCAL, 'x-orc-token': INSTALL }, {})).status).toBe(409);
    expect((await b.req('DELETE', `/api/remote/devices/${deviceId}`, { ...LOCAL, 'x-orc-token': INSTALL }, { confirm: true })).status).toBe(200);
    expect((await b.req('GET', '/api/live', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(401);
  });

  it('never hands the install token to remote requests', async () => {
    const b = build();
    const local = await b.req('GET', '/bootstrap.js', LOCAL);
    expect(await local.text()).toBe(`window.__ORC_TOKEN__ = "${INSTALL}";\n`);
    const remote = await b.req('GET', '/bootstrap.js', REMOTE);
    expect(remote.status).toBe(200);
    expect(await remote.text()).toBe('window.__ORC_TOKEN__ = null;\n');
  });

  it('saves the remote config from the Mac and reports status', async () => {
    const b = build({ enabled: false });
    const res = await b.req('POST', '/api/remote/config', { ...LOCAL, 'x-orc-token': INSTALL }, { enabled: true, origin: ORIGIN, allowedLogin: 'me@example.com' });
    expect(await res.json()).toMatchObject({ enabled: true, origin: ORIGIN, isRemote: false, funnelDetected: false });
    expect(b.ctx.config().remote.enabled).toBe(true);
    const bad = await b.req('POST', '/api/remote/config', { ...LOCAL, 'x-orc-token': INSTALL }, { enabled: true, origin: null, allowedLogin: null });
    expect(bad.status).toBe(400);
  });

  it('classifies routes', () => {
    expect(remotePolicy('GET', '/api/inbox')).toBe('device');
    expect(remotePolicy('POST', '/api/sessions/claude/s1/reply')).toBe('stepup');
    expect(remotePolicy('POST', '/api/sessions/claude/s1/plan/approve')).toBe('stepup');
    expect(remotePolicy('POST', '/api/ship/merge')).toBe('stepup');
    expect(remotePolicy('POST', '/api/inbox/i1/snooze')).toBe('device');
    expect(remotePolicy('POST', '/api/sessions/launch')).toBe('deny');
    expect(remotePolicy('GET', '/api/sessions/claude/s1/export')).toBe('deny');
    expect(remotePolicy('GET', '/assets/index.js')).toBe('public');
    expect(remotePolicy('GET', '/pty/abc')).toBe('deny');
    expect(remotePolicy('GET', '/ws')).toBe('device');
  });
});
```

`apps/daemon/src/http/ws-remote.test.ts`
```ts
import type { IncomingMessage } from 'node:http';
import { OrcConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import type { DeviceService } from '../remote/devices.ts';
import { createStepUpStore } from '../remote/step-up.ts';
import { checkWsUpgrade } from './ws-remote.ts';

const cfg = OrcConfig.parse({ remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' } });
const devices = {
  verify: (t: string | null | undefined) =>
    t === 'device-token-0123456789012345678901234567890'
      ? { id: 'd1', name: 'Phone', tokenHash: 'h', login: 'me@example.com', createdAt: '', lastSeenAt: null, revokedAt: null }
      : null,
} as unknown as DeviceService;
const deps = { config: () => cfg, devices, stepUp: createStepUpStore({ ttlMs: () => 1000 }), funnel: { detected: () => false } };
const upgrade = (url: string, headers: Record<string, string>) =>
  ({ url, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
const remoteHeaders = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'tailscale-user-login': 'me@example.com',
  origin: 'https://mac.tail1234.ts.net',
};

describe('checkWsUpgrade', () => {
  it('passes local upgrades through to the existing checks', () => {
    expect(checkWsUpgrade(upgrade('/ws?token=x', { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }), deps)).toEqual({ ok: true, remote: null });
    expect(checkWsUpgrade(upgrade('/ws', remoteHeaders), null)).toEqual({ ok: true, remote: null });
  });

  it('allows /ws for paired devices and refuses remote terminals', () => {
    expect(checkWsUpgrade(upgrade('/ws?token=device-token-0123456789012345678901234567890', remoteHeaders), deps)).toEqual({
      ok: true,
      remote: { deviceId: 'd1', deviceName: 'Phone', login: 'me@example.com' },
    });
    expect(checkWsUpgrade(upgrade('/pty/abc?token=device-token-0123456789012345678901234567890', remoteHeaders), deps)).toMatchObject({
      ok: false,
      status: 403,
      code: 'remote_forbidden',
    });
    expect(checkWsUpgrade(upgrade('/ws', remoteHeaders), deps)).toMatchObject({ ok: false, status: 401 });
    expect(checkWsUpgrade(upgrade('/ws?token=device-token-0123456789012345678901234567890', { ...remoteHeaders, origin: 'https://evil.example.com' }), deps)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/remote apps/daemon/src/http/remote-guard.test.ts apps/daemon/src/http/ws-remote.test.ts`
Expected: FAIL, `Cannot find module './classify.ts'`

- [ ] **Step 3: Implement the remote building blocks**

`apps/daemon/src/remote/classify.ts`
```ts
import { timingSafeEqual } from 'node:crypto';

export type HeaderGetter = (name: string) => string | undefined;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname;
  } catch {
    return null;
  }
}

/** `tailscale serve` proxies from 127.0.0.1, so forwarding/identity headers and the Host decide. */
export function isRemoteRequest(get: HeaderGetter, remoteAddress: string | null): boolean {
  if (!isLoopbackAddress(remoteAddress)) return true;
  if (get('tailscale-user-login') || get('tailscale-user-name')) return true;
  if (get('x-forwarded-for') || get('x-forwarded-host') || get('x-forwarded-proto') || get('forwarded')) return true;
  const host = hostnameOf(get('host'));
  return host !== null && !LOOPBACK_HOSTS.has(host);
}

export function loginMatches(given: string | null | undefined, allowed: string | null | undefined): boolean {
  const a = (given ?? '').trim().toLowerCase();
  const b = (allowed ?? '').trim().toLowerCase();
  return a !== '' && b !== '' && safeEqual(a, b);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
```

`apps/daemon/src/remote/devices.ts`
```ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OrcDb } from '../db/client.ts';
import {
  type RemoteDeviceRow,
  getRemoteDevice,
  getRemoteDeviceByTokenHash,
  insertRemoteDevice,
  listRemoteDevices,
  listWebauthnCredentials,
  revokeRemoteDevice,
  touchRemoteDevice,
} from '../db/repos/remote.ts';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface DeviceService {
  create(name: string, login: string | null): { device: RemoteDeviceRow; token: string };
  verify(token: string | null | undefined): RemoteDeviceRow | null;
  get(id: string): RemoteDeviceRow | null;
  list(): Array<RemoteDeviceRow & { credentials: number }>;
  revoke(id: string): boolean;
}

export function createDeviceService(db: OrcDb, o: { now?: () => Date } = {}): DeviceService {
  const now = () => (o.now ? o.now() : new Date());
  return {
    create(name, login) {
      const token = randomBytes(32).toString('base64url');
      const device: RemoteDeviceRow = {
        id: randomUUID(),
        name,
        tokenHash: hashToken(token),
        login,
        createdAt: now().toISOString(),
        lastSeenAt: null,
        revokedAt: null,
      };
      insertRemoteDevice(db, device);
      return { device, token };
    },
    verify(token) {
      if (!token || token.length < 32) return null;
      const row = getRemoteDeviceByTokenHash(db, hashToken(token));
      if (!row || row.revokedAt !== null) return null;
      const t = now();
      if (row.lastSeenAt === null || t.getTime() - Date.parse(row.lastSeenAt) > 60_000) {
        touchRemoteDevice(db, row.id, t.toISOString());
      }
      return row;
    },
    get: (id) => getRemoteDevice(db, id),
    list: () => listRemoteDevices(db).map((d) => ({ ...d, credentials: listWebauthnCredentials(db, d.id).length })),
    revoke: (id) => revokeRemoteDevice(db, id, now().toISOString()),
  };
}
```

`apps/daemon/src/remote/pairing.ts`
```ts
import { randomInt } from 'node:crypto';
import { safeEqual } from './classify.ts';

export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface PairingService {
  create(): { code: string; expiresAt: string };
  consume(code: string): boolean;
  activeUntil(): string | null;
}

export function createPairingService(
  o: { ttlMs?: () => number; maxFailures?: number; now?: () => number } = {},
): PairingService {
  const ttl = o.ttlMs ?? (() => 300_000);
  const maxFailures = o.maxFailures ?? 5;
  const now = o.now ?? Date.now;
  let active: { code: string; exp: number } | null = null;
  let failures = 0;

  const current = () => {
    if (active && active.exp <= now()) active = null;
    return active;
  };

  return {
    create() {
      let code = '';
      for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET.charAt(randomInt(PAIRING_ALPHABET.length));
      active = { code, exp: now() + ttl() };
      failures = 0;
      return { code, expiresAt: new Date(active.exp).toISOString() };
    },
    consume(code) {
      const a = current();
      if (!a) return false;
      if (!safeEqual(code.trim().toUpperCase(), a.code)) {
        failures++;
        if (failures >= maxFailures) active = null;
        return false;
      }
      active = null;
      return true;
    },
    activeUntil() {
      const a = current();
      return a ? new Date(a.exp).toISOString() : null;
    },
  };
}
```

`apps/daemon/src/remote/step-up.ts`
```ts
export interface StepUpStore {
  grant(deviceId: string): string;
  valid(deviceId: string): boolean;
  validUntil(deviceId: string): string | null;
  revoke(deviceId: string): void;
}

export function createStepUpStore(o: { ttlMs: () => number; now?: () => number }): StepUpStore {
  const now = o.now ?? Date.now;
  const grants = new Map<string, number>();
  const until = (deviceId: string): number | null => {
    const exp = grants.get(deviceId);
    if (exp === undefined) return null;
    if (exp <= now()) {
      grants.delete(deviceId);
      return null;
    }
    return exp;
  };
  return {
    grant(deviceId) {
      const exp = now() + o.ttlMs();
      grants.set(deviceId, exp);
      return new Date(exp).toISOString();
    },
    valid: (deviceId) => until(deviceId) !== null,
    validUntil(deviceId) {
      const exp = until(deviceId);
      return exp === null ? null : new Date(exp).toISOString();
    },
    revoke(deviceId) {
      grants.delete(deviceId);
    },
  };
}
```

`apps/daemon/src/remote/tailscale.ts`
```ts
import { execa } from 'execa';

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (cmd, args) => (await execa(cmd, args, { timeout: 5000 })).stdout;

/** `tailscale serve status --json` lists Funnel-enabled host:ports under `AllowFunnel` (verified in spike S9, check h). */
export function detectFunnel(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const allow = (status as { AllowFunnel?: unknown }).AllowFunnel;
  if (!allow || typeof allow !== 'object') return false;
  return Object.values(allow as Record<string, unknown>).some((v) => v === true);
}

export async function readServeStatus(run: RunCommand = defaultRun): Promise<unknown> {
  try {
    const out = await run('tailscale', ['serve', 'status', '--json']);
    return out.trim() ? JSON.parse(out) : {};
  } catch {
    return null;
  }
}

export interface FunnelWatch {
  detected(): boolean;
  refresh(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createFunnelWatch(
  o: { run?: RunCommand; intervalMs?: number; log?: { warn(obj: object, msg?: string): void } } = {},
): FunnelWatch {
  let detected = false;
  let timer: NodeJS.Timeout | null = null;
  const refresh = async () => {
    const was = detected;
    detected = detectFunnel(await readServeStatus(o.run));
    if (detected && !was) o.log?.warn({}, 'Tailscale Funnel detected: remote access is blocked until it is turned off');
    return detected;
  };
  return {
    detected: () => detected,
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), o.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

- [ ] **Step 4: Implement the guard, the WS check and the auth helpers**

`apps/daemon/src/http/remote-guard.ts`
```ts
import { type OrcConfig, apiError } from '@orc/api-contract';
import type { MiddlewareHandler } from 'hono';
import { type HeaderGetter, hostnameOf, isRemoteRequest, loginMatches } from '../remote/classify.ts';
import type { DeviceService } from '../remote/devices.ts';
import type { StepUpStore } from '../remote/step-up.ts';
import type { FunnelWatch } from '../remote/tailscale.ts';
import type { RemoteInfo } from './p6-util.ts';
import type { OrcEnv } from './types.ts';

export type RemotePolicy = 'public' | 'device' | 'stepup' | 'deny';

export const REMOTE_RULES: ReadonlyArray<{ method: string; pattern: RegExp; policy: RemotePolicy }> = [
  { method: 'GET', pattern: /^\/api\/connectors\/(linear|slack)\/callback$/, policy: 'public' },
  { method: 'POST', pattern: /^\/api\/remote\/pair$/, policy: 'public' },
  { method: 'GET', pattern: /^\/api\/health$/, policy: 'public' },
  { method: 'GET', pattern: /^\/api\/remote\/(devices|pairing)/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/connectors/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/sessions\/[^/]+\/[^/]+\/(export|raw)$/, policy: 'deny' },
  { method: 'GET', pattern: /^\/api\/(safety\/secrets|hooks\/install|archive)/, policy: 'deny' },
  { method: 'POST', pattern: /^\/api\/webauthn\/(register|stepup)\/(options|verify)$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/push\/(subscriptions|test)$/, policy: 'device' },
  { method: 'DELETE', pattern: /^\/api\/push\/subscriptions$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/remote\/away$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/inbox\/[^/]+\/(snooze|done|reopen)$/, policy: 'device' },
  { method: 'POST', pattern: /^\/api\/inbox\/[^/]+\/approve$/, policy: 'stepup' },
  { method: 'POST', pattern: /^\/api\/sessions\/(claude|codex)\/[^/]+\/(reply|kill)$/, policy: 'stepup' },
  { method: 'POST', pattern: /^\/api\/sessions\/(claude|codex)\/[^/]+\/plan\/(approve|reject)$/, policy: 'stepup' },
  { method: 'DELETE', pattern: /^\/api\/pty\/[^/]+$/, policy: 'stepup' },
  { method: 'POST', pattern: /^\/api\/ship\/merge$/, policy: 'stepup' },
];

export function remotePolicy(method: string, path: string): RemotePolicy {
  const m = method.toUpperCase();
  for (const r of REMOTE_RULES) if (r.method === m && r.pattern.test(path)) return r.policy;
  if (path === '/ws') return m === 'GET' ? 'device' : 'deny';
  if (path.startsWith('/pty/')) return 'deny';
  if (!path.startsWith('/api/')) return m === 'GET' || m === 'HEAD' ? 'public' : 'deny';
  return m === 'GET' ? 'device' : 'deny';
}

export interface RemoteGuardDeps {
  config: () => OrcConfig;
  devices: DeviceService;
  stepUp: StepUpStore;
  funnel: Pick<FunnelWatch, 'detected'>;
}

export type RemoteVerdict =
  | { ok: true; remote: RemoteInfo }
  | { ok: false; status: 401 | 403; code: string; message: string };

export function evaluateRemote(
  r: { method: string; path: string; get: HeaderGetter; token: string | null },
  d: RemoteGuardDeps,
): RemoteVerdict {
  const deny = (status: 401 | 403, code: string, message: string): RemoteVerdict => ({ ok: false, status, code, message });
  const cfg = d.config().remote;
  if (!cfg.enabled || !cfg.origin || !cfg.allowedLogin) {
    return deny(403, 'remote_disabled', 'remote access is disabled (Settings → Remote)');
  }
  if (d.funnel.detected()) {
    return deny(403, 'funnel_detected', 'Tailscale Funnel is on; run `tailscale funnel --https=443 off`');
  }
  const login = r.get('tailscale-user-login') ?? '';
  if (!loginMatches(login, cfg.allowedLogin)) {
    return deny(403, 'remote_identity_mismatch', 'this Tailscale user may not use the app');
  }
  const origin = new URL(cfg.origin);
  if (hostnameOf(r.get('x-forwarded-host') ?? r.get('host')) !== origin.hostname) {
    return deny(403, 'remote_bad_host', 'unexpected host');
  }
  const reqOrigin = r.get('origin');
  if (reqOrigin !== undefined && reqOrigin !== origin.origin) return deny(403, 'forbidden', 'origin not allowed');
  const policy = remotePolicy(r.method, r.path);
  if (policy === 'deny') return deny(403, 'remote_forbidden', 'not available from a remote device');
  if (policy === 'public') return { ok: true, remote: { deviceId: null, deviceName: null, login } };
  const device = d.devices.verify(r.token);
  if (!device) return deny(401, 'unauthorized', 'pair this device first');
  if (policy === 'stepup' && !d.stepUp.valid(device.id)) {
    return deny(401, 'step_up_required', 'confirm with your passkey');
  }
  return { ok: true, remote: { deviceId: device.id, deviceName: device.name, login } };
}

export function remoteGuard(d: RemoteGuardDeps | null): MiddlewareHandler<OrcEnv> {
  return async (c, next) => {
    const get: HeaderGetter = (n) => c.req.header(n);
    const addr = c.env?.incoming?.socket?.remoteAddress ?? null;
    if (d === null || !isRemoteRequest(get, addr)) {
      c.set('remote', null);
      await next();
      return;
    }
    const v = evaluateRemote(
      { method: c.req.method, path: c.req.path, get, token: c.req.header('x-orc-token') ?? c.req.query('token') ?? null },
      d,
    );
    if (!v.ok) return c.json(apiError(v.code, v.message), v.status);
    c.set('remote', v.remote);
    await next();
  };
}
```

`apps/daemon/src/http/ws-remote.ts`
```ts
import type { IncomingMessage } from 'node:http';
import { type HeaderGetter, isRemoteRequest } from '../remote/classify.ts';
import type { RemoteInfo } from './p6-util.ts';
import { type RemoteGuardDeps, evaluateRemote } from './remote-guard.ts';

export type WsVerdict = { ok: true; remote: RemoteInfo | null } | { ok: false; status: 401 | 403; code: string };

/** Local upgrades return `remote: null` and continue to P1/P2's own token + Origin checks. */
export function checkWsUpgrade(req: IncomingMessage, d: RemoteGuardDeps | null): WsVerdict {
  const get: HeaderGetter = (name) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  if (d === null || !isRemoteRequest(get, req.socket.remoteAddress ?? null)) return { ok: true, remote: null };
  const url = new URL(req.url ?? '/', 'http://remote.invalid');
  const v = evaluateRemote(
    { method: 'GET', path: url.pathname, get, token: url.searchParams.get('token') ?? get('x-orc-token') ?? null },
    d,
  );
  return v.ok ? { ok: true, remote: v.remote } : { ok: false, status: v.status, code: v.code };
}
```

Append to `apps/daemon/src/http/auth.ts` (this moves P1's inline `/api/*` and `/bootstrap.js` logic here and extends it):
```ts
import { apiError } from '@orc/api-contract';
import type { Handler, MiddlewareHandler } from 'hono';
import type { OrcEnv } from './types.ts';

export interface AccessOptions {
  token: string;
  port: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Local requests only: requests that `remoteGuard` classified as remote were already authenticated there. */
export function apiAccessMiddleware(o: AccessOptions): MiddlewareHandler<OrcEnv> {
  return async (c, next) => {
    if ((c.get('remote') ?? null) !== null) {
      await next();
      return;
    }
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!allowedHosts(o.port(), o.env).includes(host)) return c.json(apiError('forbidden', 'host not allowed'), 403);
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins(o.port(), o.env).includes(origin)) {
      return c.json(apiError('forbidden', 'origin not allowed'), 403);
    }
    if (!PUBLIC_API_PATHS.has(c.req.path) && !tokenMatches(o.token, c.req.header('x-orc-token'))) {
      return c.json(apiError('unauthorized', 'missing or invalid token'), 401);
    }
    await next();
  };
}

export function bootstrapHandler(o: AccessOptions): Handler<OrcEnv> {
  return (c) => {
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' };
    if ((c.get('remote') ?? null) !== null) return c.body('window.__ORC_TOKEN__ = null;\n', 200, headers);
    const remoteAddr = c.env?.incoming?.socket?.remoteAddress;
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const site = c.req.header('sec-fetch-site');
    const siteOk = site === undefined || site === 'same-origin' || site === 'none';
    if (!isLoopback(remoteAddr) || !allowedHosts(o.port(), o.env).includes(host) || !siteOk) {
      return c.text('forbidden', 403);
    }
    return c.body(`window.__ORC_TOKEN__ = ${JSON.stringify(o.token)};\n`, 200, headers);
  };
}
```
(Merge the new imports with the existing ones at the top of `auth.ts`.)

In `apps/daemon/src/http/app.ts`, make these changes:
1. Add `remote?: RemoteGuardDeps | null` to `AppOptions`.
2. **Replace** the inline `app.use('/api/*', …)` block and the inline `app.get('/bootstrap.js', …)` block with:
```ts
  app.use('*', remoteGuard(o.remote ?? null));
  app.use('/api/*', apiAccessMiddleware(o));
  app.get('/bootstrap.js', bootstrapHandler(o));
```
3. Update the imports: add `apiAccessMiddleware` and `bootstrapHandler` from `./auth.ts`, and `remoteGuard` and `RemoteGuardDeps` from `./remote-guard.ts`.

The P3 `auditMiddleware` stays mounted right after `apiAccessMiddleware`.

In `apps/daemon/src/http/ws.ts`, give the options object used by the `upgrade` listener an optional `remote?: RemoteGuardDeps | null`, and put this at the very top of the listener:
```ts
    const verdict = checkWsUpgrade(req, o.remote ?? null);
    if (!verdict.ok) {
      socket.write(`HTTP/1.1 ${verdict.status} ${verdict.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`);
      socket.destroy();
      return;
    }
```
Then wrap the existing token and Origin checks in `if (verdict.remote === null) { … }`. A remote upgrade has already been authenticated with its device token and `remote.origin`. `/pty/*` never reaches this point for remote requests.

- [ ] **Step 5: Implement the remote routes**

`apps/daemon/src/http/routes/remote.ts`
```ts
import { ConfirmBody, PairBody, RemoteConfigBody, type RemoteStatus } from '@orc/api-contract';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import type { DeviceService } from '../../remote/devices.ts';
import type { PairingService } from '../../remote/pairing.ts';
import type { StepUpStore } from '../../remote/step-up.ts';
import type { FunnelWatch } from '../../remote/tailscale.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { confirmOr409, need, remoteOf, requireLoopback, whoOf } from '../p6-util.ts';
import type { OrcApp, OrcEnv } from '../types.ts';

export function registerRemoteRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  d: { devices: DeviceService; pairing: PairingService; stepUp: StepUpStore; funnel: FunnelWatch },
): void {
  const audit = () => need(ctx.audit, 'audit');

  function status(c: Context<OrcEnv>): RemoteStatus {
    const cfg = ctx.config().remote;
    const r = remoteOf(c);
    return {
      enabled: cfg.enabled,
      origin: cfg.origin,
      allowedLogin: r ? null : cfg.allowedLogin,
      isRemote: r !== null,
      deviceId: r?.deviceId ?? null,
      stepUpValidUntil: r?.deviceId ? d.stepUp.validUntil(r.deviceId) : null,
      funnelDetected: d.funnel.detected(),
      pairingActiveUntil: r ? null : d.pairing.activeUntil(),
    };
  }

  app.get('/api/remote/status', (c) => c.json(status(c)));

  app.post('/api/remote/config', async (c) => {
    requireLoopback(c);
    const body = await readJson(c, RemoteConfigBody);
    if (body.enabled && (!body.origin || !body.allowedLogin)) {
      throw new ServiceError('validation_failed', 400, 'origin and allowedLogin are required to enable remote access');
    }
    need(ctx.updateConfig, 'updateConfig')((cfg) => ({
      ...cfg,
      remote: { ...cfg.remote, enabled: body.enabled, origin: body.origin, allowedLogin: body.allowedLogin },
    }));
    await d.funnel.refresh();
    audit().record({
      ...whoOf(c), action: 'remote.configure', target: body.origin, params: { enabled: body.enabled, allowedLogin: body.allowedLogin },
      result: 'ok', error: null,
    });
    return c.json(status(c));
  });

  app.post('/api/remote/pairing', (c) => {
    requireLoopback(c);
    const cfg = ctx.config().remote;
    if (!cfg.enabled || !cfg.origin) throw new ServiceError('remote_disabled', 409, 'enable remote access first');
    const p = d.pairing.create();
    audit().record({ ...whoOf(c), action: 'remote.pairing_code', target: null, params: { expiresAt: p.expiresAt }, result: 'ok', error: null });
    return c.json({ code: p.code, expiresAt: p.expiresAt, url: `${cfg.origin}/pair` });
  });

  app.post('/api/remote/pair', async (c) => {
    const r = remoteOf(c);
    if (!r) throw new ServiceError('not_remote', 400, 'open the pairing page through the Tailscale address on the device');
    const body = await readJson(c, PairBody);
    const detail = `${body.name} (${r.login})`;
    if (!d.pairing.consume(body.code)) {
      audit().record({ actor: 'remote', actorDetail: detail, action: 'remote.pair', target: null, params: {}, result: 'denied', error: 'invalid code' });
      throw new ServiceError('invalid_code', 403, 'wrong or expired pairing code');
    }
    const { device, token } = d.devices.create(body.name, r.login);
    audit().record({ actor: 'remote', actorDetail: detail, action: 'remote.pair', target: device.id, params: { name: body.name }, result: 'ok', error: null });
    return c.json({ deviceId: device.id, deviceToken: token });
  });

  app.get('/api/remote/devices', (c) => {
    requireLoopback(c);
    return c.json(
      d.devices.list().map((x) => ({
        id: x.id, name: x.name, login: x.login, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt,
        revokedAt: x.revokedAt, credentials: x.credentials,
      })),
    );
  });

  app.delete('/api/remote/devices/:id', async (c) => {
    requireLoopback(c);
    const id = c.req.param('id');
    const { confirm } = await readJson(c, ConfirmBody);
    const device = d.devices.get(id);
    if (!device) throw new ServiceError('not_found', 404, 'unknown device');
    confirmOr409(confirm, `Revoke ${device.name}? It loses access, its passkeys and its push subscriptions.`);
    d.devices.revoke(id);
    d.stepUp.revoke(id);
    audit().record({ ...whoOf(c), action: 'remote.revoke', target: id, params: { name: device.name }, result: 'ok', error: null });
    return c.json({ ok: true as const });
  });
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/remote apps/daemon/src/http`
Expected: PASS (6 + 10 + 2 new tests). P1's `app.test.ts` still passes: the local rules are unchanged, and `remoteGuard(null)` treats every request as local.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add Tailscale remote guard, device pairing, route policy and step-up store"
```

---

### Task 13: Reply and approve for owned sessions (step-up for remote, deny-list, audit as `remote`)

**Files:**
- Create: `apps/daemon/src/services/remote/session-actions.ts` (replaces the Task 2 stub), `apps/daemon/src/services/remote/session-actions.test.ts`
- Create: `apps/daemon/src/http/routes/session-actions.ts`

**Interfaces:**
- Consumes:
  - `actorScope` (Task 3)
  - `Who`, `whoOf`, `confirmOr409`, `need` (Task 2)
  - `ReplyBody`, `ApproveBody` (Task 2)
  - `remoteGuard` and the `stepup` rules (Task 12)
  - `audited` (P3), `ctx.denyList` (P3), `ctx.inbox` (P2), `ctx.plans?.approve(pk)` (P4), `sessionPk` (P1)
- Produces:
  ```ts
  export const DEFAULT_APPROVE_TEXT = 'Approved — proceed with the plan.';
  export function inboxSessionPk(item: InboxItem): string | null
  export interface SessionActions { reply(i: { pk: string; text: string } & Who): Promise<void>; approve(i: { itemId: string } & Who): Promise<InboxItem> }
  export function createSessionActions(ctx: DaemonContext): SessionActions
  export function registerSessionActionRoutes(app: OrcApp, ctx: DaemonContext, d: { actions: SessionActions }): void
  ```
- Behaviour:
  - `inboxSessionPk` looks in this order:
    1. `payload.source` + `payload.id` (the P2 convention)
    2. the dedupe key `<kind>:<pk>` (P2 and P4 `plan:${pk}`)
    3. `sessionId`, if it contains `:`
    4. `claude:${sessionId}`
  - **`reply`:**
    - Only for owned sessions → else `403 not_owned`.
    - Remote actors are checked against the deny-list. A match returns `403 denied` and records an audit entry with result `denied`.
    - The text is sent through `ctx.pty.sendText`, inside `actorScope.run(who)`, so P3's wrapper records `pty.input` with the right actor.
  - **`approve`:**
    - For `plan_approval` items, it requires an owned session. It calls `ctx.plans.approve(pk)` when P4 is wired; otherwise it sends `payload.approveText` (or `DEFAULT_APPROVE_TEXT`) as a reply. It then marks the item done, unless P4 already closed it.
    - For `automation_result` items, it marks the item done.
    - Any other kind returns `409 not_approvable`.
    - Audited as `remote.approve` for remote actors and `inbox.approve` otherwise.
  - The approve route requires `confirm: true`. Remote requests also need step-up (enforced by the guard).

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/remote/session-actions.test.ts`
```ts
import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInboxItem, makeP6Session, ownedLive, p6Context } from '../../../test/p6-fakes.ts';
import { useTempHomes } from '../../../test/helpers.ts';
import { remoteGuard } from '../../http/remote-guard.ts';
import { registerSessionActionRoutes } from '../../http/routes/session-actions.ts';
import type { OrcEnv } from '../../http/types.ts';
import { createDeviceService } from '../../remote/devices.ts';
import { createStepUpStore } from '../../remote/step-up.ts';
import type { PlanApprovalService } from '../review/plan-approval.ts';
import { ServiceError } from '../errors.ts';
import { DEFAULT_APPROVE_TEXT, createSessionActions, inboxSessionPk } from './session-actions.ts';

const REMOTE = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'tailscale-user-login': 'me@example.com',
  'content-type': 'application/json',
};
type Err = { error: { code: string } };

describe('inboxSessionPk', () => {
  it('prefers the payload, then the dedupe key, then sessionId', () => {
    expect(inboxSessionPk(makeInboxItem({ id: 'a' }))).toBe('claude:s1');
    expect(inboxSessionPk(makeInboxItem({ id: 'b', payload: {}, dedupeKey: 'plan:codex:c9' }))).toBe('codex:c9');
    expect(inboxSessionPk(makeInboxItem({ id: 'c', payload: {}, dedupeKey: 'pr:org/repo#1:checks', sessionId: 'x1' }))).toBe('claude:x1');
    expect(inboxSessionPk(makeInboxItem({ id: 'd', payload: {}, dedupeKey: 'budget:global', sessionId: null }))).toBeNull();
  });
});

describe('session actions', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { owned?: boolean; plans?: boolean } = {}) {
    const session = makeP6Session({ id: 's1', live: o.owned === false ? { ...ownedLive(), ownership: 'observed', ptyId: null } : ownedLive('pty-1') });
    const items = [
      makeInboxItem({ id: 'plan1', kind: 'plan_approval', dedupeKey: 'plan:claude:s1', payload: { source: 'claude', id: 's1', approveText: 'yes, go' } }),
      makeInboxItem({ id: 'wait1' }),
      makeInboxItem({ id: 'auto1', kind: 'automation_result', dedupeKey: 'automation:r1', payload: {} }),
    ];
    const env = p6Context({
      sessions: [session],
      inbox: items,
      config: { remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' } },
    });
    cleanups.push(() => env.ctx.dispose());
    const approve = vi.fn(async () => {});
    if (o.plans) env.ctx.plans = { approve, reject: vi.fn(async () => {}) } as unknown as PlanApprovalService;
    const devices = createDeviceService(env.ctx.db);
    const stepUp = createStepUpStore({ ttlMs: () => 300_000 });
    const { device, token } = devices.create('Phone', 'me@example.com');
    const app = new Hono<OrcEnv>();
    app.onError((err, c) =>
      err instanceof ServiceError ? c.json(apiError(err.code, err.message), err.status) : c.json(apiError('internal', String(err)), 500),
    );
    app.use('*', remoteGuard({ config: env.ctx.config, devices, stepUp, funnel: { detected: () => false } }));
    const actions = createSessionActions(env.ctx);
    registerSessionActionRoutes(app, env.ctx, { actions });
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      app.request(`http://127.0.0.1:4317${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const local = { host: '127.0.0.1:4317', 'content-type': 'application/json' };
    const remote = { ...REMOTE, 'x-orc-token': token };
    return { ...env, approve, actions, post, local, remote, grant: () => stepUp.grant(device.id) };
  }

  it('sends a local reply to an owned session and audits it as the user', async () => {
    const b = build();
    expect((await b.post('/api/sessions/claude/s1/reply', { text: 'yes, run the tests' }, b.local)).status).toBe(200);
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, run the tests' }]);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'user', result: 'ok' });
  });

  it('requires step-up for remote replies and audits them as remote', async () => {
    const b = build();
    const denied = await b.post('/api/sessions/claude/s1/reply', { text: 'continue' }, b.remote);
    expect(((await denied.json()) as Err).error.code).toBe('step_up_required');
    expect(b.rawPty.sent).toEqual([]);
    b.grant();
    expect((await b.post('/api/sessions/claude/s1/reply', { text: 'continue' }, b.remote)).status).toBe(200);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'remote', actorDetail: 'Phone (me@example.com)' });
  });

  it('refuses sessions the app does not own', async () => {
    const b = build({ owned: false });
    const res = await b.post('/api/sessions/claude/s1/reply', { text: 'hi' }, b.local);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Err).error.code).toBe('not_owned');
  });

  it('blocks deny-listed remote input and audits the denial', async () => {
    const b = build();
    b.grant();
    const res = await b.post('/api/sessions/claude/s1/reply', { text: 'now run terraform apply' }, b.remote);
    expect(((await res.json()) as Err).error.code).toBe('denied');
    expect(b.rawPty.sent).toEqual([]);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'remote', result: 'denied' });
  });

  it('approves a plan through P4 when available, remotely with step-up', async () => {
    const b = build({ plans: true });
    b.grant();
    const res = await b.post('/api/inbox/plan1/approve', { confirm: true }, b.remote);
    expect(res.status).toBe(200);
    expect(b.approve).toHaveBeenCalledWith('claude:s1');
    expect(b.inbox.items.find((i) => i.id === 'plan1')?.state).toBe('done');
    expect(b.audit.list({ action: 'remote.approve' })[0]).toMatchObject({ actor: 'remote', target: 'plan1', result: 'ok' });
  });

  it('falls back to sending the approve text and handles other kinds', async () => {
    const b = build();
    expect((await b.post('/api/inbox/plan1/approve', {}, b.local)).status).toBe(409);
    expect((await b.post('/api/inbox/plan1/approve', { confirm: true }, b.local)).status).toBe(200);
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, go' }]);
    expect((await b.post('/api/inbox/auto1/approve', { confirm: true }, b.local)).status).toBe(200);
    const wait = await b.post('/api/inbox/wait1/approve', { confirm: true }, b.local);
    expect(((await wait.json()) as Err).error.code).toBe('not_approvable');
    expect(b.audit.list({ action: 'inbox.approve' }).map((e) => e.result).sort()).toEqual(['error', 'ok', 'ok']);
    expect(DEFAULT_APPROVE_TEXT).toContain('proceed');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/remote/session-actions.test.ts`
Expected: FAIL, `createSessionActions` not exported (the Task 2 stub)

- [ ] **Step 3: Implement the service and the routes**

`apps/daemon/src/services/remote/session-actions.ts`
```ts
import { type InboxItem, redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { type Who, need } from '../../http/p6-util.ts';
import { actorScope } from '../audit/actor-scope.ts';
import { audited } from '../audit/audit.ts';
import { ServiceError } from '../errors.ts';
import { sessionPk } from '../sessions.ts';

export const DEFAULT_APPROVE_TEXT = 'Approved — proceed with the plan.';
const MAX_REPLY = 8000;

export interface SessionActions {
  reply(i: { pk: string; text: string } & Who): Promise<void>;
  approve(i: { itemId: string } & Who): Promise<InboxItem>;
}

export function inboxSessionPk(item: InboxItem): string | null {
  const src = item.payload.source;
  const id = item.payload.id;
  if ((src === 'claude' || src === 'codex' || src === 'agnc') && typeof id === 'string') return sessionPk(src, id);
  const m = /^[a-z_]+:((?:claude|codex|agnc):.+)$/.exec(item.dedupeKey);
  if (m?.[1]) return m[1];
  if (item.sessionId?.includes(':')) return item.sessionId;
  return item.sessionId ? sessionPk('claude', item.sessionId) : null;
}

export function createSessionActions(ctx: DaemonContext): SessionActions {
  function ownedPty(pk: string): { ptyId: string; projectId: string | null } {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
    const live = s.live;
    if (!live || live.ownership !== 'owned' || !live.ptyId) {
      throw new ServiceError('not_owned', 403, 'input is only sent to sessions running in the app');
    }
    return { ptyId: live.ptyId, projectId: s.projectId };
  }

  async function reply(i: { pk: string; text: string } & Who): Promise<void> {
    const text = i.text.trim();
    if (!text) throw new ServiceError('validation_failed', 400, 'empty reply');
    if (text.length > MAX_REPLY) throw new ServiceError('validation_failed', 400, 'reply is too long');
    const { ptyId, projectId } = ownedPty(i.pk);
    if (i.actor !== 'user') {
      const verdict = need(ctx.denyList, 'denyList').check(text, projectId);
      if (verdict.denied) {
        need(ctx.audit, 'audit').record({
          actor: i.actor, actorDetail: i.actorDetail, action: 'pty.input', target: i.pk,
          params: { via: 'remote', text: redact(text).slice(0, 500) }, result: 'denied', error: verdict.reason,
        });
        throw new ServiceError('denied', 403, `blocked by the deny-list: ${verdict.reason ?? 'matched a pattern'}`);
      }
    }
    await actorScope.run({ actor: i.actor, actorDetail: i.actorDetail }, () => ctx.pty.sendText(ptyId, text));
  }

  async function approve(i: { itemId: string } & Who): Promise<InboxItem> {
    const inbox = need(ctx.inbox, 'inbox');
    const find = () => inbox.list({}).find((x) => x.id === i.itemId);
    const item = find();
    if (!item) throw new ServiceError('not_found', 404, 'inbox item not found');
    if (item.state === 'done' || item.state === 'auto_resolved') {
      throw new ServiceError('not_approvable', 409, 'this item is already closed');
    }
    const pk = inboxSessionPk(item);
    return audited(
      need(ctx.audit, 'audit'),
      {
        actor: i.actor,
        actorDetail: i.actorDetail,
        action: i.actor === 'remote' ? 'remote.approve' : 'inbox.approve',
        target: item.id,
        params: { kind: item.kind, sessionPk: pk },
      },
      async () => {
        if (item.kind === 'plan_approval') {
          if (!pk) throw new ServiceError('not_approvable', 409, 'plan item has no session');
          ownedPty(pk);
          const plans = ctx.plans;
          if (plans) {
            await actorScope.run({ actor: i.actor, actorDetail: i.actorDetail }, () => plans.approve(pk));
          } else {
            const text = typeof item.payload.approveText === 'string' ? item.payload.approveText : DEFAULT_APPROVE_TEXT;
            await reply({ pk, text, actor: i.actor, actorDetail: i.actorDetail });
          }
          const fresh = find() ?? item;
          return fresh.state === 'open' || fresh.state === 'snoozed' ? inbox.markDone(item.id) : fresh;
        }
        if (item.kind === 'automation_result') return inbox.markDone(item.id);
        throw new ServiceError('not_approvable', 409, `${item.kind} items cannot be approved`);
      },
    );
  }

  return { reply, approve };
}
```

`apps/daemon/src/http/routes/session-actions.ts`
```ts
import { ApproveBody, ReplyBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { SessionActions } from '../../services/remote/session-actions.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readJson } from '../json.ts';
import { confirmOr409, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export function registerSessionActionRoutes(app: OrcApp, _ctx: DaemonContext, d: { actions: SessionActions }): void {
  app.post('/api/sessions/:source/:id/reply', async (c) => {
    const source = c.req.param('source');
    if (source !== 'claude' && source !== 'codex') throw new ServiceError('not_found', 404, 'unknown source');
    const { text } = await readJson(c, ReplyBody);
    await d.actions.reply({ pk: sessionPk(source, c.req.param('id')), text, ...whoOf(c) });
    return c.json({ ok: true as const });
  });

  app.post('/api/inbox/:id/approve', async (c) => {
    const { confirm } = await readJson(c, ApproveBody);
    confirmOr409(confirm, 'Approve this item? For a plan, the session continues with the plan.');
    return c.json(await d.actions.approve({ itemId: c.req.param('id'), ...whoOf(c) }));
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/remote/session-actions.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add owned-session reply and approve with step-up, deny-list and audit"
```

---

### Task 14: WebAuthn passkeys — registration at pairing time, step-up assertions

**Files:**
- Modify: `apps/daemon/package.json` (`@simplewebauthn/server`)
- Create: `apps/daemon/src/remote/webauthn.ts`, `apps/daemon/src/remote/webauthn.test.ts`
- Create: `apps/daemon/src/http/routes/webauthn.ts`

**Interfaces:**
- Consumes:
  - `@simplewebauthn/server@^14.0.2` (checked against `esm/*.d.ts`):
    ```ts
    generateRegistrationOptions({ rpName, rpID, userName, userID?: Uint8Array, userDisplayName?, attestationType?, authenticatorSelection?, timeout? })
      // → PublicKeyCredentialCreationOptionsJSON with .challenge
    verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID?, requireUserVerification? })
      // → { verified: true; registrationInfo: { credential: { id; publicKey: Uint8Array; counter; transports? } } }
    generateAuthenticationOptions({ rpID, allowCredentials?, userVerification?, timeout? })
    verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, credential, requireUserVerification? })
      // → { verified; authenticationInfo: { newCounter } }
    ```
  - `DeviceService`, `StepUpStore` (Task 12)
  - repo credential functions (Task 3)
  - `requireRemoteDevice`, `need` (Task 2); `WebAuthnVerifyBody` (Task 2); `audited` (P3)
- Produces:
  ```ts
  export interface WebAuthnLib { generateRegistrationOptions: typeof generateRegistrationOptions; verifyRegistrationResponse: typeof verifyRegistrationResponse; generateAuthenticationOptions: typeof generateAuthenticationOptions; verifyAuthenticationResponse: typeof verifyAuthenticationResponse }
  export const defaultWebAuthnLib: WebAuthnLib
  export const REGISTRATION_WINDOW_MS = 15 * 60_000;
  export interface WebAuthnService { registrationOptions(deviceId: string): Promise<PublicKeyCredentialCreationOptionsJSON>; verifyRegistration(deviceId: string, response: RegistrationResponseJSON): Promise<{ credentialId: string }>; stepUpOptions(deviceId: string): Promise<PublicKeyCredentialRequestOptionsJSON>; verifyStepUp(deviceId: string, response: AuthenticationResponseJSON): Promise<{ validUntil: string }> }
  export function createWebAuthnService(d: { db: OrcDb; config: () => OrcConfig; devices: DeviceService; stepUp: StepUpStore; lib?: WebAuthnLib; now?: () => number }): WebAuthnService
  export function registerWebAuthnRoutes(app: OrcApp, ctx: DaemonContext, d: { webauthn: WebAuthnService }): void
  ```
- Behaviour:
  - The RP ID is the hostname of `remote.origin` (the MagicDNS name) and the expected origin is `remote.origin`. Passkeys are therefore always created on the Tailscale origin, never on `127.0.0.1`: WebAuthn doesn't allow IP-address RP IDs, and a `localhost` passkey wouldn't work on the phone.
  - Registration is allowed only for a device with **no** credential yet, within 15 minutes of pairing (the pairing code is the desktop's approval). Otherwise the response is `403 registration_window_closed`.
  - User verification is required.
  - Challenges are per device, single use, and valid for 2 minutes.
  - A step-up must use a credential that belongs to the calling device. On success the counter is updated and `stepUp.grant(deviceId)` is returned.
  - Routes require a paired **remote** device (`403 remote_only` otherwise). Registration is audited as `webauthn.register`.

- [ ] **Step 1: Install and write the failing test**

Run: `pnpm --filter @orc/daemon add @simplewebauthn/server@^14.0.2`

`apps/daemon/src/remote/webauthn.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { send, p6TestApp } from '../../test/p6-app.ts';
import { p6Context } from '../../test/p6-fakes.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { getWebauthnCredential } from '../db/repos/remote.ts';
import { registerWebAuthnRoutes } from '../http/routes/webauthn.ts';
import { createDeviceService } from './devices.ts';
import { createStepUpStore } from './step-up.ts';
import { type WebAuthnLib, createWebAuthnService } from './webauthn.ts';

type RegOpts = Parameters<WebAuthnLib['generateRegistrationOptions']>[0];
type RegVerify = Parameters<WebAuthnLib['verifyRegistrationResponse']>[0];
type AuthOpts = Parameters<WebAuthnLib['generateAuthenticationOptions']>[0];
type AuthVerify = Parameters<WebAuthnLib['verifyAuthenticationResponse']>[0];
type Err = { error: { code: string } };

function fakeLib() {
  const regOpts = vi.fn(async (o: RegOpts) => ({
    challenge: 'reg-chal', rp: { name: o.rpName, id: o.rpID }, user: { id: 'dXNlcg', name: o.userName, displayName: o.userName }, pubKeyCredParams: [],
  }));
  const regVerify = vi.fn(async (_o: RegVerify) => ({
    verified: true,
    registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } },
  }));
  const authOpts = vi.fn(async (o: AuthOpts) => ({ challenge: 'auth-chal', rpId: o.rpID, allowCredentials: o.allowCredentials }));
  const authVerify = vi.fn(async (_o: AuthVerify) => ({ verified: true, authenticationInfo: { newCounter: 7 } }));
  const lib = {
    generateRegistrationOptions: regOpts,
    verifyRegistrationResponse: regVerify,
    generateAuthenticationOptions: authOpts,
    verifyAuthenticationResponse: authVerify,
  } as unknown as WebAuthnLib;
  return { lib, regOpts, regVerify, authOpts, authVerify };
}

describe('webauthn', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { enabled?: boolean } = {}) {
    const { ctx, audit } = p6Context({
      config: { remote: { enabled: o.enabled ?? true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' } },
    });
    cleanups.push(() => ctx.dispose());
    let now = Date.parse('2026-09-17T10:00:00.000Z');
    const devices = createDeviceService(ctx.db, { now: () => new Date(now) });
    const stepUp = createStepUpStore({ ttlMs: () => 300_000, now: () => now });
    const f = fakeLib();
    const webauthn = createWebAuthnService({ db: ctx.db, config: ctx.config, devices, stepUp, lib: f.lib, now: () => now });
    const app = p6TestApp();
    registerWebAuthnRoutes(app, ctx, { webauthn });
    const { device } = devices.create('Phone', 'me@example.com');
    const other = devices.create('Tablet', 'me@example.com').device;
    const as = (id: string) => ({ 'x-test-remote': id });
    return { ctx, audit, app, device, other, stepUp, f, as, advance: (ms: number) => { now += ms; } };
  }

  it('registers one passkey for a freshly paired device', async () => {
    const b = build();
    const opts = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    expect(await opts.json()).toMatchObject({ challenge: 'reg-chal', rp: { id: 'mac.tail1234.ts.net' } });
    expect(b.f.regOpts.mock.calls[0]?.[0]).toMatchObject({ rpID: 'mac.tail1234.ts.net', userName: 'me@example.com', attestationType: 'none' });
    const ok = await send(b.app, 'POST', '/api/webauthn/register/verify', { response: { id: 'cred-1' } }, b.as(b.device.id));
    expect(await ok.json()).toEqual({ credentialId: 'cred-1' });
    expect(b.f.regVerify.mock.calls[0]?.[0]).toMatchObject({
      expectedChallenge: 'reg-chal', expectedOrigin: 'https://mac.tail1234.ts.net', expectedRPID: 'mac.tail1234.ts.net', requireUserVerification: true,
    });
    expect(getWebauthnCredential(b.ctx.db, 'cred-1')).toMatchObject({ deviceId: b.device.id, publicKey: 'AQID', transports: ['internal'] });
    expect(b.audit.list({ action: 'webauthn.register' })[0]).toMatchObject({ actor: 'remote', result: 'ok' });

    const again = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    expect(((await again.json()) as Err).error.code).toBe('registration_window_closed');
  });

  it('closes registration 15 minutes after pairing and rejects replays', async () => {
    const b = build();
    const replay = await send(b.app, 'POST', '/api/webauthn/register/verify', { response: { id: 'x' } }, b.as(b.device.id));
    expect(((await replay.json()) as Err).error.code).toBe('invalid_state');
    b.advance(15 * 60_000 + 1);
    const late = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.other.id));
    expect(((await late.json()) as Err).error.code).toBe('registration_window_closed');
  });

  it('grants a step-up for the device’s own passkey only', async () => {
    const b = build();
    await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    await send(b.app, 'POST', '/api/webauthn/register/verify', { response: { id: 'cred-1' } }, b.as(b.device.id));

    const opts = await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.device.id));
    expect(await opts.json()).toMatchObject({ challenge: 'auth-chal', allowCredentials: [{ id: 'cred-1', transports: ['internal'] }] });
    const ok = await send(b.app, 'POST', '/api/webauthn/stepup/verify', { response: { id: 'cred-1' } }, b.as(b.device.id));
    expect(await ok.json()).toEqual({ validUntil: '2026-09-17T10:05:00.000Z' });
    expect(b.stepUp.valid(b.device.id)).toBe(true);
    expect(getWebauthnCredential(b.ctx.db, 'cred-1')?.counter).toBe(7);
    expect(b.f.authVerify.mock.calls[0]?.[0]).toMatchObject({
      expectedChallenge: 'auth-chal', expectedRPID: 'mac.tail1234.ts.net', credential: { id: 'cred-1', counter: 0 },
    });

    const noCreds = await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.other.id));
    expect(((await noCreds.json()) as Err).error.code).toBe('unknown_credential');
    b.f.authOpts.mockClear();
    await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.device.id));
    const foreign = await send(b.app, 'POST', '/api/webauthn/stepup/verify', { response: { id: 'cred-of-someone' } }, b.as(b.device.id));
    expect(((await foreign.json()) as Err).error.code).toBe('unknown_credential');
  });

  it('refuses local callers and disabled remote access', async () => {
    const b = build();
    const local = await send(b.app, 'POST', '/api/webauthn/stepup/options', {});
    expect(((await local.json()) as Err).error.code).toBe('remote_only');
    const off = build({ enabled: false });
    const res = await send(off.app, 'POST', '/api/webauthn/register/options', {}, off.as(off.device.id));
    expect(((await res.json()) as Err).error.code).toBe('remote_disabled');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/remote/webauthn.test.ts`
Expected: FAIL, `Cannot find module './webauthn.ts'`

- [ ] **Step 3: Implement the service and the routes**

`apps/daemon/src/remote/webauthn.ts`
```ts
import type { OrcConfig } from '@orc/api-contract';
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { OrcDb } from '../db/client.ts';
import {
  getWebauthnCredential,
  insertWebauthnCredential,
  listWebauthnCredentials,
  updateWebauthnCounter,
} from '../db/repos/remote.ts';
import { ServiceError } from '../services/errors.ts';
import type { DeviceService } from './devices.ts';
import type { StepUpStore } from './step-up.ts';

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const defaultWebAuthnLib: WebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export const REGISTRATION_WINDOW_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 120_000;

export interface WebAuthnService {
  registrationOptions(deviceId: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(deviceId: string, response: RegistrationResponseJSON): Promise<{ credentialId: string }>;
  stepUpOptions(deviceId: string): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyStepUp(deviceId: string, response: AuthenticationResponseJSON): Promise<{ validUntil: string }>;
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createWebAuthnService(d: {
  db: OrcDb;
  config: () => OrcConfig;
  devices: DeviceService;
  stepUp: StepUpStore;
  lib?: WebAuthnLib;
  now?: () => number;
}): WebAuthnService {
  const lib = d.lib ?? defaultWebAuthnLib;
  const now = d.now ?? Date.now;
  const challenges = new Map<string, { kind: 'register' | 'stepup'; challenge: string; exp: number }>();

  function rp(): { origin: string; rpID: string; userName: string } {
    const cfg = d.config().remote;
    if (!cfg.enabled || !cfg.origin) throw new ServiceError('remote_disabled', 403, 'remote access is disabled');
    const url = new URL(cfg.origin);
    return { origin: url.origin, rpID: url.hostname, userName: cfg.allowedLogin ?? 'orchestrator' };
  }

  function device(id: string) {
    const dev = d.devices.get(id);
    if (!dev || dev.revokedAt !== null) throw new ServiceError('unauthorized', 401, 'unknown device');
    return dev;
  }

  function takeChallenge(deviceId: string, kind: 'register' | 'stepup'): string {
    const c = challenges.get(deviceId);
    challenges.delete(deviceId);
    if (!c || c.kind !== kind || c.exp <= now()) throw new ServiceError('invalid_state', 400, 'challenge expired; try again');
    return c.challenge;
  }

  return {
    async registrationOptions(deviceId) {
      const dev = device(deviceId);
      const { rpID, userName } = rp();
      const tooLate = now() - Date.parse(dev.createdAt) > REGISTRATION_WINDOW_MS;
      if (listWebauthnCredentials(d.db, deviceId).length > 0 || tooLate) {
        throw new ServiceError('registration_window_closed', 403, 'passkeys can only be added right after pairing; pair the device again');
      }
      const options = await lib.generateRegistrationOptions({
        rpName: 'Orchestrator',
        rpID,
        userName,
        userDisplayName: `${userName} (${dev.name})`,
        userID: new TextEncoder().encode(dev.id),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: CHALLENGE_TTL_MS,
      });
      challenges.set(deviceId, { kind: 'register', challenge: options.challenge, exp: now() + CHALLENGE_TTL_MS });
      return options;
    },

    async verifyRegistration(deviceId, response) {
      device(deviceId);
      const { origin, rpID } = rp();
      const expectedChallenge = takeChallenge(deviceId, 'register');
      let result: Awaited<ReturnType<WebAuthnLib['verifyRegistrationResponse']>>;
      try {
        result = await lib.verifyRegistrationResponse({
          response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        });
      } catch (e) {
        throw new ServiceError('validation_failed', 400, `passkey registration failed: ${message(e)}`);
      }
      if (!result.verified) throw new ServiceError('validation_failed', 400, 'passkey registration was not verified');
      const cred = result.registrationInfo.credential;
      insertWebauthnCredential(d.db, {
        id: cred.id,
        deviceId,
        publicKey: toB64(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ?? [],
        createdAt: new Date(now()).toISOString(),
        lastUsedAt: null,
      });
      return { credentialId: cred.id };
    },

    async stepUpOptions(deviceId) {
      device(deviceId);
      const { rpID } = rp();
      const creds = listWebauthnCredentials(d.db, deviceId);
      if (creds.length === 0) throw new ServiceError('unknown_credential', 403, 'no passkey is registered for this device');
      const options = await lib.generateAuthenticationOptions({
        rpID,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
        timeout: CHALLENGE_TTL_MS,
      });
      challenges.set(deviceId, { kind: 'stepup', challenge: options.challenge, exp: now() + CHALLENGE_TTL_MS });
      return options;
    },

    async verifyStepUp(deviceId, response) {
      device(deviceId);
      const { origin, rpID } = rp();
      const expectedChallenge = takeChallenge(deviceId, 'stepup');
      const stored = getWebauthnCredential(d.db, response.id);
      if (!stored || stored.deviceId !== deviceId) {
        throw new ServiceError('unknown_credential', 403, 'this passkey does not belong to this device');
      }
      let result: Awaited<ReturnType<WebAuthnLib['verifyAuthenticationResponse']>>;
      try {
        result = await lib.verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: { id: stored.id, publicKey: fromB64(stored.publicKey), counter: stored.counter, transports: stored.transports },
          requireUserVerification: true,
        });
      } catch (e) {
        throw new ServiceError('step_up_failed', 403, `passkey check failed: ${message(e)}`);
      }
      if (!result.verified) throw new ServiceError('step_up_failed', 403, 'passkey check failed');
      updateWebauthnCounter(d.db, stored.id, result.authenticationInfo.newCounter, new Date(now()).toISOString());
      return { validUntil: d.stepUp.grant(deviceId) };
    },
  };
}
```

`apps/daemon/src/http/routes/webauthn.ts`
```ts
import { WebAuthnVerifyBody } from '@orc/api-contract';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { DaemonContext } from '../../context.ts';
import type { WebAuthnService } from '../../remote/webauthn.ts';
import { audited } from '../../services/audit/audit.ts';
import { readJson } from '../json.ts';
import { need, requireRemoteDevice } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export function registerWebAuthnRoutes(app: OrcApp, ctx: DaemonContext, d: { webauthn: WebAuthnService }): void {
  app.post('/api/webauthn/register/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await d.webauthn.registrationOptions(r.deviceId));
  });

  app.post('/api/webauthn/register/verify', async (c) => {
    const r = requireRemoteDevice(c);
    const { response } = await readJson(c, WebAuthnVerifyBody);
    const out = await audited(
      need(ctx.audit, 'audit'),
      { actor: 'remote', actorDetail: `${r.deviceName ?? 'device'} (${r.login})`, action: 'webauthn.register', target: r.deviceId, params: {} },
      () => d.webauthn.verifyRegistration(r.deviceId, response as unknown as RegistrationResponseJSON),
    );
    return c.json(out);
  });

  app.post('/api/webauthn/stepup/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await d.webauthn.stepUpOptions(r.deviceId));
  });

  app.post('/api/webauthn/stepup/verify', async (c) => {
    const r = requireRemoteDevice(c);
    const { response } = await readJson(c, WebAuthnVerifyBody);
    return c.json(await d.webauthn.verifyStepUp(r.deviceId, response as unknown as AuthenticationResponseJSON));
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/remote/webauthn.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add WebAuthn passkey registration and step-up for remote devices"
```

---

### Task 15: Web Push — VAPID keys, subscriptions, `webpush` notify channel

**Files:**
- Modify: `apps/daemon/package.json` (`web-push`, `@types/web-push`)
- Create: `apps/daemon/src/notify/format.ts`, `apps/daemon/src/notify/vapid.ts`, `apps/daemon/src/notify/webpush.ts`, `apps/daemon/src/notify/webpush.test.ts`
- Create: `apps/daemon/src/http/routes/push.ts`

**Interfaces:**
- Consumes:
  - `web-push@^3.6.7` (checked against `@types/web-push`):
    ```ts
    generateVAPIDKeys(): { publicKey; privateKey }
    sendNotification(subscription, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL, urgency, topic })
      // → { statusCode }; rejects with WebPushError { statusCode }
    ```
  - P2 `KIND_TITLE`, `NotifyChannelImpl`
  - push subscription repo functions (Task 3)
  - `PushSubscriptionBody`, `PushUnsubscribeBody` (Task 2); `remoteOf` (Task 2)
- Produces:
  ```ts
  // notify/format.ts
  export interface PushPayload { title: string; body: string; url: string; tag: string; itemId: string }
  export function pushPayload(item: InboxItem, url: string): PushPayload      // body redacted, ≤ 180 chars, no transcript beyond item.reason
  export function remoteUrl(localUrl: string, origin: string | null): string   // rewrites http://127.0.0.1:<port>/x → <origin>/x
  // notify/vapid.ts
  export interface VapidKeys { publicKey: string; privateKey: string; createdAt: string }
  export function loadOrCreateVapidKeys(orcHome: string, gen?: () => { publicKey: string; privateKey: string }, now?: () => Date): VapidKeys   // $ORC_HOME/vapid.json, mode 0600
  // notify/webpush.ts
  export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: 'high'; topic: string }) => Promise<{ statusCode: number }>;
  export function isAllowedPushEndpoint(endpoint: string): boolean     // https + FCM / Mozilla / Apple / Windows push hosts only (prevents SSRF)
  export interface WebPushChannel extends NotifyChannelImpl { sendTest(): Promise<number> }
  export function createWebPushChannel(d: { db: OrcDb; keys: VapidKeys; config: () => OrcConfig; send?: PushSender; log?: { warn(o: object, m?: string): void } }): WebPushChannel
  // http/routes/push.ts
  export function registerPushRoutes(app: OrcApp, ctx: DaemonContext, d: { keys: VapidKeys; channel: WebPushChannel }): void
  ```
- Behaviour:
  - The VAPID subject is `mailto:<remote.allowedLogin>`, falling back to `mailto:orchestrator@example.com`.
  - A `404` or `410` from the push service deletes the subscription. Any other failure increments `failures`, and the subscription is deleted at 5.
  - Subscriptions whose endpoint host is not allowed are refused (`400 bad_push_endpoint`) and are dropped if found in the database.
  - A remote subscription stores the calling `deviceId`, so revoking the device removes it.

- [ ] **Step 1: Install and write the failing test**

Run: `pnpm --filter @orc/daemon add web-push@^3.6.7 && pnpm --filter @orc/daemon add -D @types/web-push@^3.6.4`

`apps/daemon/src/notify/webpush.test.ts`
```ts
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { send, p6TestApp } from '../../test/p6-app.ts';
import { makeInboxItem, p6Context } from '../../test/p6-fakes.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { insertRemoteDevice, listPushSubscriptions, upsertPushSubscription } from '../db/repos/remote.ts';
import { registerPushRoutes } from '../http/routes/push.ts';
import { pushPayload, remoteUrl } from './format.ts';
import { loadOrCreateVapidKeys } from './vapid.ts';
import { type PushSender, createWebPushChannel, isAllowedPushEndpoint } from './webpush.ts';

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const APPLE = 'https://web.push.apple.com/QABC';
const T = '2026-09-17T10:00:00.000Z';

describe('web push', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(remote: Record<string, unknown> = { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' }) {
    const { ctx } = p6Context({ config: { remote } });
    cleanups.push(() => ctx.dispose());
    const keys = loadOrCreateVapidKeys(ctx.paths.orcHome, () => ({ publicKey: 'BPUB', privateKey: 'PRIV' }), () => new Date(T));
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
    const channel = createWebPushChannel({ db: ctx.db, keys, config: ctx.config, send: sender });
    return { ctx, keys, sender, channel };
  }

  it('creates VAPID keys once with mode 0600', () => {
    const s = setup();
    expect(s.keys).toEqual({ publicKey: 'BPUB', privateKey: 'PRIV', createdAt: T });
    const file = join(s.ctx.paths.orcHome, 'vapid.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = loadOrCreateVapidKeys(s.ctx.paths.orcHome, () => ({ publicKey: 'OTHER', privateKey: 'OTHER' }));
    expect(again.publicKey).toBe('BPUB');
  });

  it('formats a redacted payload with a tailnet URL', () => {
    const item = makeInboxItem({ id: 'i1', reason: 'Waiting: token=abc123 ok?' });
    expect(remoteUrl('http://127.0.0.1:4317/sessions/claude/s1?x=1', 'https://mac.tail1234.ts.net')).toBe(
      'https://mac.tail1234.ts.net/sessions/claude/s1?x=1',
    );
    expect(remoteUrl('http://127.0.0.1:4317/inbox', null)).toBe('http://127.0.0.1:4317/inbox');
    expect(pushPayload(item, 'https://x/inbox')).toMatchObject({
      body: '[wakecap] SAF-1787 · Waiting: token=«redacted:secret» ok?',
      tag: 'waiting:claude:s1',
      itemId: 'i1',
    });
  });

  it('sends to every subscription and prunes gone or failing ones', async () => {
    const s = setup();
    upsertPushSubscription(s.ctx.db, { deviceId: null, endpoint: FCM, p256dh: 'p1', auth: 'a1', createdAt: T });
    upsertPushSubscription(s.ctx.db, { deviceId: null, endpoint: APPLE, p256dh: 'p2', auth: 'a2', createdAt: T });
    upsertPushSubscription(s.ctx.db, { deviceId: null, endpoint: 'https://evil.example.com/push', p256dh: 'p3', auth: 'a3', createdAt: T });
    s.sender.mockImplementation(async (sub) => {
      if (sub.endpoint === APPLE) throw Object.assign(new Error('gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    await s.channel.send(makeInboxItem({ id: 'i1' }), 'http://127.0.0.1:4317/sessions/claude/s1');
    expect(s.sender).toHaveBeenCalledTimes(2);
    const [sub, payload, options] = s.sender.mock.calls[0] ?? [];
    expect(sub).toEqual({ endpoint: FCM, keys: { p256dh: 'p1', auth: 'a1' } });
    expect(JSON.parse(String(payload))).toMatchObject({ title: 'Waiting for you', url: 'https://mac.tail1234.ts.net/sessions/claude/s1' });
    expect(options).toMatchObject({ vapidDetails: { subject: 'mailto:me@example.com', publicKey: 'BPUB', privateKey: 'PRIV' }, TTL: 3600, urgency: 'high' });
    expect(options?.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(listPushSubscriptions(s.ctx.db).map((x) => x.endpoint)).toEqual([FCM]);

    s.sender.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    for (let i = 0; i < 5; i++) await s.channel.send(makeInboxItem({ id: 'i1' }), 'http://127.0.0.1:4317/inbox');
    expect(listPushSubscriptions(s.ctx.db)).toEqual([]);
  });

  it('allows only real push service endpoints', () => {
    expect(isAllowedPushEndpoint(FCM)).toBe(true);
    expect(isAllowedPushEndpoint(APPLE)).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1/x')).toBe(false);
  });

  it('manages subscriptions over HTTP', async () => {
    const s = setup();
    insertRemoteDevice(s.ctx.db, { id: 'd1', name: 'Phone', tokenHash: 'h', login: 'me@example.com', createdAt: T, lastSeenAt: null, revokedAt: null });
    const app = p6TestApp();
    registerPushRoutes(app, s.ctx, { keys: s.keys, channel: s.channel });
    expect(await (await send(app, 'GET', '/api/push/vapid-public-key')).json()).toEqual({ publicKey: 'BPUB' });
    const bad = await send(app, 'POST', '/api/push/subscriptions', { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'BExampleKey1', auth: 'authsecret' } });
    expect(bad.status).toBe(400);
    const ok = await send(app, 'POST', '/api/push/subscriptions', { endpoint: FCM, keys: { p256dh: 'BExampleKey1', auth: 'authsecret' } }, { 'x-test-remote': 'd1' });
    expect(ok.status).toBe(200);
    expect(listPushSubscriptions(s.ctx.db)[0]).toMatchObject({ endpoint: FCM, deviceId: 'd1' });
    expect(await (await send(app, 'POST', '/api/push/test', {})).json()).toEqual({ sent: 1 });
    expect((await send(app, 'DELETE', '/api/push/subscriptions', { endpoint: FCM })).status).toBe(200);
    expect(listPushSubscriptions(s.ctx.db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/notify/webpush.test.ts`
Expected: FAIL, `Cannot find module './format.ts'`

- [ ] **Step 3: Implement the format helpers, the key store, the channel and the routes**

`apps/daemon/src/notify/format.ts`
```ts
import { type InboxItem, redact } from '@orc/core';
import { KIND_TITLE } from './macos.ts';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  itemId: string;
}

export function pushPayload(item: InboxItem, url: string): PushPayload {
  const project = item.projectId ? `[${item.projectId}] ` : '';
  const ticket = item.ticket ? `${item.ticket} · ` : '';
  return {
    title: KIND_TITLE[item.kind],
    body: `${project}${ticket}${redact(item.reason)}`.slice(0, 180),
    url,
    tag: item.dedupeKey,
    itemId: item.id,
  };
}

/** Notification URLs are built for 127.0.0.1 (P2); a phone needs the tailnet origin instead. */
export function remoteUrl(localUrl: string, origin: string | null): string {
  if (!origin) return localUrl;
  const u = new URL(localUrl);
  return `${origin.replace(/\/$/, '')}${u.pathname}${u.search}`;
}
```

`apps/daemon/src/notify/vapid.ts`
```ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export function loadOrCreateVapidKeys(
  orcHome: string,
  gen: () => { publicKey: string; privateKey: string } = () => webpush.generateVAPIDKeys(),
  now: () => Date = () => new Date(),
): VapidKeys {
  const file = join(orcHome, 'vapid.json');
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      chmodSync(file, 0o600);
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, createdAt: parsed.createdAt ?? now().toISOString() };
    }
  }
  const k = gen();
  const keys: VapidKeys = { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: now().toISOString() };
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}
```

`apps/daemon/src/notify/webpush.ts`
```ts
import { createHash } from 'node:crypto';
import type { OrcConfig } from '@orc/api-contract';
import webpush from 'web-push';
import type { OrcDb } from '../db/client.ts';
import { deletePushSubscription, listPushSubscriptions, markPushFailure, markPushOk } from '../db/repos/remote.ts';
import { type PushPayload, pushPayload, remoteUrl } from './format.ts';
import type { NotifyChannelImpl } from './notifier.ts';
import type { VapidKeys } from './vapid.ts';

export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: {
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
    TTL: number;
    urgency: 'high';
    topic: string;
  },
) => Promise<{ statusCode: number }>;

const ALLOWED_PUSH_HOSTS: readonly RegExp[] = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface WebPushChannel extends NotifyChannelImpl {
  sendTest(): Promise<number>;
}

const topicFor = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

export function createWebPushChannel(d: {
  db: OrcDb;
  keys: VapidKeys;
  config: () => OrcConfig;
  send?: PushSender;
  log?: { warn(o: object, m?: string): void };
}): WebPushChannel {
  const sender: PushSender = d.send ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));

  async function deliver(payload: PushPayload): Promise<number> {
    const cfg = d.config();
    const subject = `mailto:${cfg.remote.allowedLogin ?? 'orchestrator@example.com'}`;
    let sent = 0;
    for (const s of listPushSubscriptions(d.db)) {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        deletePushSubscription(d.db, s.endpoint);
        continue;
      }
      try {
        await sender(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          {
            vapidDetails: { subject, publicKey: d.keys.publicKey, privateKey: d.keys.privateKey },
            TTL: 3600,
            urgency: 'high',
            topic: topicFor(payload.tag),
          },
        );
        markPushOk(d.db, s.endpoint, new Date().toISOString());
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) deletePushSubscription(d.db, s.endpoint);
        else if (markPushFailure(d.db, s.endpoint) >= 5) deletePushSubscription(d.db, s.endpoint);
        d.log?.warn({ status, err: e instanceof Error ? e.message : String(e) }, 'web push delivery failed');
      }
    }
    return sent;
  }

  return {
    id: 'webpush',
    async send(item, url) {
      await deliver(pushPayload(item, remoteUrl(url, d.config().remote.origin)));
    },
    sendTest() {
      const base = d.config().remote.origin ?? `http://127.0.0.1:${d.config().port}`;
      return deliver({ title: 'Orchestrator', body: 'Test notification', url: `${base}/inbox`, tag: 'orchestrator-test', itemId: 'test' });
    },
  };
}
```

`apps/daemon/src/http/routes/push.ts`
```ts
import { PushSubscriptionBody, PushUnsubscribeBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { deletePushSubscription, upsertPushSubscription } from '../../db/repos/remote.ts';
import type { VapidKeys } from '../../notify/vapid.ts';
import { type WebPushChannel, isAllowedPushEndpoint } from '../../notify/webpush.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { remoteOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export function registerPushRoutes(app: OrcApp, ctx: DaemonContext, d: { keys: VapidKeys; channel: WebPushChannel }): void {
  app.get('/api/push/vapid-public-key', (c) => c.json({ publicKey: d.keys.publicKey }));

  app.post('/api/push/subscriptions', async (c) => {
    const body = await readJson(c, PushSubscriptionBody);
    if (!isAllowedPushEndpoint(body.endpoint)) {
      throw new ServiceError('bad_push_endpoint', 400, 'unsupported push service endpoint');
    }
    upsertPushSubscription(ctx.db, {
      deviceId: remoteOf(c)?.deviceId ?? null,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      createdAt: new Date().toISOString(),
    });
    return c.json({ ok: true as const });
  });

  app.delete('/api/push/subscriptions', async (c) => {
    const { endpoint } = await readJson(c, PushUnsubscribeBody);
    deletePushSubscription(ctx.db, endpoint);
    return c.json({ ok: true as const });
  });

  app.post('/api/push/test', async (c) => c.json({ sent: await d.channel.sendTest() }));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/notify/webpush.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add VAPID web push channel and push subscription routes"
```

---

### Task 16: Slack DM bridge — inbox items as DM threads, replies to owned sessions, ✅/💤 reactions

**Files:**
- Create: `apps/daemon/src/services/remote/slack-bridge.ts`, `apps/daemon/src/services/remote/slack-bridge.test.ts`
- Create: `apps/daemon/src/notify/slack-dm.ts`

**Interfaces:**
- Consumes:
  - `SlackConnector` (Task 6), `decodeSlackText` (Task 6)
  - slack thread repo functions (Task 3); `getConnectorMeta` (Task 3)
  - `SessionActions`, `inboxSessionPk` (Task 13); `remoteUrl` (Task 15)
  - P2 `KIND_TITLE`, `NotifyChannelImpl`, `ctx.inbox`, bus `inbox.upserted`
- Produces:
  ```ts
  export const APPROVE_REACTION = 'white_check_mark';
  export const SNOOZE_REACTION = 'zzz';
  export type BridgeCommand = { kind: 'done' } | { kind: 'approve' } | { kind: 'snooze'; minutes: number } | { kind: 'reply'; text: string };
  export function parseBridgeCommand(text: string): BridgeCommand
  export function escapeSlack(text: string): string
  export function formatSlackItem(item: InboxItem, url: string, replyable: boolean): string
  export interface SlackBridge   // as in Contract additions §11
  export function createSlackBridge(d: { ctx: DaemonContext; slack: SlackConnector; actions: SessionActions; now?: () => Date }): SlackBridge
  // notify/slack-dm.ts
  export function createSlackDmChannel(bridge: Pick<SlackBridge, 'ensureThread'>): NotifyChannelImpl   // id 'slack_dm'
  ```
- Behaviour (verified approach):
  - **Posting.** The notifier sends an item to `slack_dm` (normally while away). The bridge posts **one** root message to my self-DM (`conversations.open` with my own user id) and stores `slack_threads` with `app_ts = [rootTs]`. Links use `remote.origin` when set.
  - **Polling (every `bridgePollSeconds` = 15 s, open threads only).** Each poll:
    - Reads my reactions on the root through `conversations.replies`. The parent message carries `reactions[]`, so no `reactions:read` scope is needed.
    - `white_check_mark` → `approve`. `zzz` → snooze for 60 min. Each reaction is handled once (`reactions_done_json`).
    - Reads replies after `last_seen_ts`. It ignores anything whose ts is in `app_ts`, anything not from **my** user id, and anything with `bot_id`/`app_id`.
    - Advances `last_seen_ts` **before** running each command, so a crash can't send a message twice.
  - **Commands** (`!` prefix, because Slack intercepts `/`):
    - `!done` → mark the item done
    - `!approve` → approve
    - `!snooze [minutes]` → snooze (default 60, max 1440)
    - anything else → `actions.reply({ actor: 'remote', actorDetail: 'slack_dm' })`, which covers owned-only, deny-list and audit
  - **Feedback.** The bridge answers in the thread (`✓ sent`, or `✗ <code>`) and records each answer's ts in `app_ts`.
  - **Resolving.** When `inbox.upserted` reports `done` or `auto_resolved`, the bridge posts "Resolved" in the thread and marks the thread `resolved`.
  - **When off.** Nothing happens when Slack is not connected. When `dmBridge` is off, the root message is still posted as a plain notification, and the thread is stored as `resolved`, so it is never polled.
  - Slack replies can't do a passkey step-up. Compensating controls: messages must come from my own user id in my own self-DM, deny-list, owned sessions only, audit. The bridge can be switched off with `connectors.slack.dmBridge: false`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/remote/slack-bridge.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSlackApi } from '../../../test/p6-connector-fakes.ts';
import { makeInboxItem, makeP6Session, ownedLive, p6Context } from '../../../test/p6-fakes.ts';
import { useTempHomes } from '../../../test/helpers.ts';
import { createSlackConnector } from '../../connectors/slack/slack.ts';
import { upsertConnectorMeta } from '../../db/repos/connectors.ts';
import { getSlackThread } from '../../db/repos/slack-threads.ts';
import { createSlackDmChannel } from '../../notify/slack-dm.ts';
import { createMemorySecretStore } from '../secrets/secret-store.ts';
import { createSessionActions } from './session-actions.ts';
import { createSlackBridge, formatSlackItem, parseBridgeCommand } from './slack-bridge.ts';

const T = '2026-09-17T10:00:00.000Z';
const URL_LOCAL = 'http://127.0.0.1:4317/sessions/claude/s1';

describe('slack bridge helpers', () => {
  it('parses commands', () => {
    expect(parseBridgeCommand('!done')).toEqual({ kind: 'done' });
    expect(parseBridgeCommand(' !APPROVE ')).toEqual({ kind: 'approve' });
    expect(parseBridgeCommand('!snooze')).toEqual({ kind: 'snooze', minutes: 60 });
    expect(parseBridgeCommand('!snooze 5000')).toEqual({ kind: 'snooze', minutes: 1440 });
    expect(parseBridgeCommand('use &lt;T&gt; &amp; go')).toEqual({ kind: 'reply', text: 'use <T> & go' });
  });

  it('formats items without Slack markup injection', () => {
    const text = formatSlackItem(makeInboxItem({ id: 'i', reason: 'Pick <!channel> or <https://x|y>?' }), 'https://mac.ts.net/x', true);
    expect(text).toContain('*Waiting for you* · wakecap · SAF-1787');
    expect(text).toContain('Pick &lt;!channel&gt; or &lt;https://x|y&gt;?');
    expect(text).toContain('<https://mac.ts.net/x|Open in Orchestrator>');
    expect(text).toContain('Reply in this thread');
    expect(formatSlackItem(makeInboxItem({ id: 'i' }), 'u', false)).toContain('replies are off');
  });
});

describe('slack bridge', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { owned?: boolean; connected?: boolean; config?: Record<string, unknown> } = {}) {
    const session = makeP6Session({
      id: 's1',
      live: o.owned === false ? { ...ownedLive(), ownership: 'observed', ptyId: null } : ownedLive('pty-1'),
    });
    const items = [
      makeInboxItem({ id: 'w1', reason: 'Waiting: run migrations? password=hunter2' }),
      makeInboxItem({ id: 'p1', kind: 'plan_approval', dedupeKey: 'plan:claude:s1', payload: { source: 'claude', id: 's1', approveText: 'approved' } }),
    ];
    const env = p6Context({
      sessions: [session],
      inbox: items,
      config: o.config ?? { remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' } },
    });
    cleanups.push(() => env.ctx.dispose());
    if (o.connected !== false) {
      upsertConnectorMeta(env.ctx.db, { connector: 'slack', authKind: 'user_token', accountId: 'U-ME', accountLabel: 'me', scopes: [], connectedAt: T });
    }
    const api = fakeSlackApi();
    const slack = createSlackConnector({ secrets: createMemorySecretStore({ 'slack.token': 'xoxp-test-123456' }), api: () => api });
    const bridge = createSlackBridge({ ctx: env.ctx, slack, actions: createSessionActions(env.ctx), now: () => new Date(T) });
    bridge.start();
    cleanups.push(() => bridge.stop());
    const channel = createSlackDmChannel(bridge);
    const item = (id: string) => {
      const found = env.inbox.items.find((i) => i.id === id);
      if (!found) throw new Error(id);
      return found;
    };
    return { ...env, api, bridge, channel, item };
  }

  it('posts one redacted DM thread per item with a tailnet link', async () => {
    const b = build();
    await b.channel.send(b.item('w1'), URL_LOCAL);
    await b.channel.send(b.item('w1'), URL_LOCAL);
    expect(b.api.posts).toHaveLength(1);
    expect(b.api.posts[0]?.channel).toBe('D-ME');
    expect(b.api.posts[0]?.text).toContain('password=«redacted:secret»');
    expect(b.api.posts[0]?.text).toContain('<https://mac.tail1234.ts.net/sessions/claude/s1|Open in Orchestrator>');
    expect(getSlackThread(b.ctx.db, 'w1')).toMatchObject({ sessionPk: 'claude:s1', state: 'open', channel: 'D-ME' });
  });

  it('sends my thread replies to the owned session exactly once', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'yes, run them');
    b.api.userReply(root, 'ignore me', 'U-OTHER');
    await b.bridge.poll();
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, run them' }]);
    expect(b.api.posts.at(-1)).toMatchObject({ threadTs: root, text: ':arrow_right: Sent to the session.' });
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'remote', actorDetail: 'slack_dm' });
  });

  it('reports refusals in the thread', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'terraform apply now');
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([]);
    expect(b.api.posts.at(-1)?.text).toMatch(/^:x: Not done \(denied\)/);
  });

  it('refuses replies for sessions the app does not own', async () => {
    const b = build({ owned: false });
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    expect(b.api.posts[0]?.text).toContain('replies are off');
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.userReply(root, 'continue');
    await b.bridge.poll();
    expect(b.api.posts.at(-1)?.text).toMatch(/^:x: Not done \(not_owned\)/);
  });

  it('approves on ✅ once and resolves the thread', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('p1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'p1')?.rootTs ?? '';
    b.api.react(root, 'white_check_mark');
    await b.bridge.poll();
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'p1')?.state).toBe('resolved'));
    await b.bridge.poll();
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'approved' }]);
    expect(b.item('p1').state).toBe('done');
    await vi.waitFor(() => expect(b.api.posts.some((p) => p.text.startsWith(':heavy_check_mark: Resolved'))).toBe(true));
  });

  it('snoozes on 💤 and on !snooze, and marks done on !done', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    const root = getSlackThread(b.ctx.db, 'w1')?.rootTs ?? '';
    b.api.react(root, 'zzz');
    await b.bridge.poll();
    expect(b.item('w1')).toMatchObject({ state: 'snoozed', snoozeUntil: '2026-09-17T11:00:00.000Z' });
    b.api.userReply(root, '!snooze 30');
    await b.bridge.poll();
    expect(b.item('w1').snoozeUntil).toBe('2026-09-17T10:30:00.000Z');
    b.api.userReply(root, '!done');
    await b.bridge.poll();
    expect(b.item('w1').state).toBe('done');
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'w1')?.state).toBe('resolved'));
  });

  it('resolves when the inbox item clears on its own', async () => {
    const b = build();
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    b.inbox.resolve('waiting:claude:s1');
    await vi.waitFor(() => expect(getSlackThread(b.ctx.db, 'w1')?.state).toBe('resolved'));
    await vi.waitFor(() => expect(b.api.posts.at(-1)?.text).toBe(':heavy_check_mark: Resolved (condition cleared).'));
  });

  it('does nothing when Slack is not connected, and does not poll when the bridge is off', async () => {
    const off = build({ connected: false });
    await off.bridge.ensureThread(off.item('w1'), URL_LOCAL);
    expect(off.api.posts).toEqual([]);
    const noBridge = build({ config: { connectors: { slack: { dmBridge: false } } } });
    await noBridge.bridge.ensureThread(noBridge.item('w1'), URL_LOCAL);
    expect(noBridge.api.posts).toHaveLength(1);
    expect(getSlackThread(noBridge.ctx.db, 'w1')?.state).toBe('resolved');
  });

  it('nudges through a Slackbot reminder when configured', async () => {
    const b = build({ config: { connectors: { slack: { nudgeViaReminder: true } } } });
    await b.bridge.ensureThread(b.item('w1'), URL_LOCAL);
    expect(b.api.reminders).toEqual(['Orchestrator: Waiting for you — Waiting: run migrations? password=«redacted:secret»']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/remote/slack-bridge.test.ts`
Expected: FAIL, `Cannot find module './slack-bridge.ts'`

- [ ] **Step 3: Implement the bridge and the channel**

`apps/daemon/src/services/remote/slack-bridge.ts`
```ts
import { type InboxItem, type InboxState, redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import { decodeSlackText } from '../../connectors/slack/text.ts';
import { getConnectorMeta } from '../../db/repos/connectors.ts';
import {
  type SlackThread,
  getSlackThread,
  insertSlackThread,
  listOpenSlackThreads,
  updateSlackThread,
} from '../../db/repos/slack-threads.ts';
import { need } from '../../http/p6-util.ts';
import { remoteUrl } from '../../notify/format.ts';
import { KIND_TITLE } from '../../notify/macos.ts';
import { ServiceError } from '../errors.ts';
import { type SessionActions, inboxSessionPk } from './session-actions.ts';

export const APPROVE_REACTION = 'white_check_mark';
export const SNOOZE_REACTION = 'zzz';
const ALL_STATES: InboxState[] = ['open', 'snoozed', 'done', 'auto_resolved'];

export type BridgeCommand =
  | { kind: 'done' }
  | { kind: 'approve' }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'reply'; text: string };

export function parseBridgeCommand(text: string): BridgeCommand {
  const t = decodeSlackText(text).trim();
  if (/^!done$/i.test(t)) return { kind: 'done' };
  if (/^!approve$/i.test(t)) return { kind: 'approve' };
  const snooze = /^!snooze(?:\s+(\d{1,5}))?$/i.exec(t);
  if (snooze) return { kind: 'snooze', minutes: Math.min(1440, Math.max(1, Number(snooze[1] ?? 60))) };
  return { kind: 'reply', text: t };
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatSlackItem(item: InboxItem, url: string, replyable: boolean): string {
  const meta = [item.projectId, item.ticket].filter((x): x is string => Boolean(x)).map(escapeSlack);
  const head = [`*${escapeSlack(KIND_TITLE[item.kind])}*`, ...meta].join(' · ');
  const help = replyable
    ? 'Reply in this thread to answer the session · react :white_check_mark: to approve · :zzz: to snooze 1h · `!done` · `!snooze 30`'
    : '_This session is not running in the app, so replies are off._ React :zzz: to snooze 1h · `!done`';
  return [head, escapeSlack(redact(item.reason)), `<${url}|Open in Orchestrator>`, help].join('\n');
}

export interface SlackBridge {
  ensureThread(item: InboxItem, url: string): Promise<void>;
  onInboxUpserted(item: InboxItem): Promise<void>;
  poll(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createSlackBridge(d: {
  ctx: DaemonContext;
  slack: SlackConnector;
  actions: SessionActions;
  now?: () => Date;
}): SlackBridge {
  const { ctx } = d;
  const now = () => (d.now ? d.now() : new Date());
  const who = { actor: 'remote' as const, actorDetail: 'slack_dm' };
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let polling = false;

  const connected = () => ctx.config().connectors.slack.enabled && getConnectorMeta(ctx.db, 'slack') !== null;

  function isOwned(pk: string | null): boolean {
    if (!pk) return false;
    const live = ctx.sessions.getByPk(pk)?.live;
    return live !== null && live !== undefined && live.ownership === 'owned' && live.ptyId !== null;
  }

  async function say(inboxItemId: string, text: string): Promise<void> {
    const t = getSlackThread(ctx.db, inboxItemId);
    if (!t) return;
    const { ts } = await d.slack.post(t.channel, text, t.rootTs);
    const latest = getSlackThread(ctx.db, inboxItemId) ?? t;
    updateSlackThread(ctx.db, inboxItemId, { appTs: [...latest.appTs, ts].slice(-200) }, now().toISOString());
  }

  async function resolve(inboxItemId: string, state: InboxState): Promise<void> {
    const t = getSlackThread(ctx.db, inboxItemId);
    if (!t || t.state !== 'open') return;
    updateSlackThread(ctx.db, inboxItemId, { state: 'resolved' }, now().toISOString());
    await say(inboxItemId, `:heavy_check_mark: Resolved (${state === 'done' ? 'done' : 'condition cleared'}).`);
  }

  async function run(t: SlackThread, item: InboxItem, cmd: BridgeCommand): Promise<void> {
    const inbox = need(ctx.inbox, 'inbox');
    try {
      switch (cmd.kind) {
        case 'done':
          inbox.markDone(item.id);
          return;
        case 'snooze': {
          const until = new Date(now().getTime() + cmd.minutes * 60_000).toISOString();
          inbox.snooze(item.id, until);
          await say(t.inboxItemId, `:zzz: Snoozed until ${until}.`);
          return;
        }
        case 'approve':
          await d.actions.approve({ itemId: item.id, ...who });
          return;
        case 'reply':
          if (!t.sessionPk) {
            await say(t.inboxItemId, ':x: Not done (no_session): this item has no session.');
            return;
          }
          await d.actions.reply({ pk: t.sessionPk, text: cmd.text, ...who });
          await say(t.inboxItemId, ':arrow_right: Sent to the session.');
          return;
      }
    } catch (e) {
      const code = e instanceof ServiceError ? e.code : 'error';
      await say(t.inboxItemId, `:x: Not done (${code}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pollThread(t: SlackThread, item: InboxItem | null, myUserId: string): Promise<void> {
    if (!item || item.state === 'done' || item.state === 'auto_resolved') {
      await resolve(t.inboxItemId, item?.state ?? 'done');
      return;
    }
    const reactions = await d.slack.reactions(t.channel, t.rootTs);
    const done = new Set(t.reactionsDone);
    for (const [name, cmd] of [
      [APPROVE_REACTION, { kind: 'approve' }],
      [SNOOZE_REACTION, { kind: 'snooze', minutes: 60 }],
    ] as const) {
      if (!reactions.includes(name) || done.has(name)) continue;
      done.add(name);
      updateSlackThread(ctx.db, t.inboxItemId, { reactionsDone: [...done] }, now().toISOString());
      await run(t, item, cmd);
    }
    const replies = await d.slack.replies(t.channel, t.rootTs, t.lastSeenTs);
    for (const m of replies) {
      updateSlackThread(ctx.db, t.inboxItemId, { lastSeenTs: m.ts }, now().toISOString());
      const appTs = getSlackThread(ctx.db, t.inboxItemId)?.appTs ?? t.appTs;
      if (appTs.includes(m.ts) || m.user !== myUserId || m.botId !== null || m.appId !== null) continue;
      await run(t, item, parseBridgeCommand(m.text));
    }
  }

  async function ensureThread(item: InboxItem, url: string): Promise<void> {
    if (!connected() || getSlackThread(ctx.db, item.id)) return;
    const cfg = ctx.config();
    const me = await d.slack.me();
    const pk = inboxSessionPk(item);
    const bridge = cfg.connectors.slack.dmBridge;
    const text = formatSlackItem(item, remoteUrl(url, cfg.remote.origin), bridge && isOwned(pk));
    const { ts } = await d.slack.post(me.dmChannelId, text);
    const at = now().toISOString();
    insertSlackThread(ctx.db, {
      inboxItemId: item.id, sessionPk: pk, channel: me.dmChannelId, rootTs: ts, lastSeenTs: ts,
      appTs: [ts], reactionsDone: [], state: bridge ? 'open' : 'resolved', createdAt: at, updatedAt: at,
    });
    if (cfg.connectors.slack.nudgeViaReminder) {
      try {
        await d.slack.nudge(`Orchestrator: ${KIND_TITLE[item.kind]} — ${item.reason}`);
      } catch (err) {
        ctx.log.warn({ err: String(err) }, 'slack reminder nudge failed');
      }
    }
  }

  async function onInboxUpserted(item: InboxItem): Promise<void> {
    if (item.state === 'done' || item.state === 'auto_resolved') await resolve(item.id, item.state);
  }

  async function poll(): Promise<void> {
    if (polling || !connected() || !ctx.config().connectors.slack.dmBridge) return;
    polling = true;
    try {
      const me = await d.slack.me();
      const items = new Map(need(ctx.inbox, 'inbox').list({ state: ALL_STATES }).map((i) => [i.id, i]));
      for (const t of listOpenSlackThreads(ctx.db)) {
        try {
          await pollThread(t, items.get(t.inboxItemId) ?? null, me.userId);
        } catch (err) {
          ctx.log.warn({ err: String(err), item: t.inboxItemId }, 'slack bridge poll failed');
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    ensureThread,
    onInboxUpserted,
    poll,
    start() {
      if (timer) return;
      unsubscribe = ctx.bus.on('inbox.upserted', (e) => {
        onInboxUpserted(e.item).catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'slack bridge resolve failed'));
      });
      timer = setInterval(() => void poll(), ctx.config().connectors.slack.bridgePollSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
```

`apps/daemon/src/notify/slack-dm.ts`
```ts
import type { SlackBridge } from '../services/remote/slack-bridge.ts';
import type { NotifyChannelImpl } from './notifier.ts';

/** Slack DM to myself (as me). The bridge turns the message into a reply-able thread. */
export function createSlackDmChannel(bridge: Pick<SlackBridge, 'ensureThread'>): NotifyChannelImpl {
  return { id: 'slack_dm', send: (item, url) => bridge.ensureThread(item, url) };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/remote/slack-bridge.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add Slack DM bridge for replying to owned sessions from Slack"
```

---

### Task 17: Away mode — manual toggle, macOS idle detection, notification routing

**Files:**
- Create: `apps/daemon/src/remote/idle.ts`, `apps/daemon/src/remote/away.ts` (replaces the Task 2 stub), `apps/daemon/src/notify/routing.ts`, `apps/daemon/src/remote/away.test.ts`
- Create: `apps/daemon/src/http/routes/away.ts`
- Modify: `apps/daemon/src/notify/notifier.ts` (use `selectChannels`), `apps/daemon/src/remote/tailscale.ts` (export `runCommand`)

**Interfaces:**
- Consumes:
  - `Notifier`, `NotifyPref`, `prefFor`, `createNotifier`, `NotifyChannel` (P2)
  - `EventBus` and `away.changed` (Task 2); `AwayBody`, `AwayMode`, `AwayState` (Task 2)
  - `RunCommand` (Task 12); `whoOf`, `need` (Task 2)
- Produces:
  ```ts
  // remote/tailscale.ts (now exported)
  export const runCommand: RunCommand
  // remote/idle.ts
  export function parseHidIdleSeconds(ioregOutput: string): number | null     // HIDIdleTime is in nanoseconds
  export function readIdleSeconds(o?: { run?: RunCommand; platform?: NodeJS.Platform }): Promise<number | null>   // runs `ioreg -c IOHIDSystem`; null off macOS
  // remote/away.ts
  export interface AwayService { state(): AwayState; setMode(mode: AwayMode): Promise<AwayState>; tick(): Promise<AwayState>; start(): void; stop(): void }
  export function createAwayService(d: { config: () => OrcConfig; notifier: Notifier; bus: EventBus; idle?: () => Promise<number | null>; intervalMs?: number }): AwayService
  // notify/routing.ts
  export function selectChannels(i: { pref: NotifyPref; away: boolean; awayChannels: NotifyChannel[] }): NotifyChannel[]
  // http/routes/away.ts
  export function registerAwayRoutes(app: OrcApp, ctx: DaemonContext, d: { away: AwayService }): void
  ```
- Behaviour:
  - Mode `on` → away. Mode `off` → present. Mode `auto` → away when `away.auto` is true and the idle time is at least `away.idleMinutes × 60` seconds.
  - A change calls `notifier.setAway()` and emits `away.changed`.
  - The mode lives in memory. After a restart it is `auto`.
  - The service re-checks every 30 s.
  - **Routing:**
    - A disabled pref sends nothing.
    - While away, `macos` is dropped and `away.channels` (default `webpush` and `slack_dm`) are added.
    - While present, the pref's own channels are used unchanged.
  - Setting the mode is audited as `away.set`. Remote devices may set it (route policy `device`).

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/remote/away.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import type { BusEvent } from '../live/event-bus.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { send, p6TestApp } from '../../test/p6-app.ts';
import { makeInboxItem, p6Context } from '../../test/p6-fakes.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { createEventBus } from '../live/event-bus.ts';
import { registerAwayRoutes } from '../http/routes/away.ts';
import { type NotifyChannelImpl, createNotifier } from '../notify/notifier.ts';
import { selectChannels } from '../notify/routing.ts';
import { createAwayService } from './away.ts';
import { parseHidIdleSeconds, readIdleSeconds } from './idle.ts';

const IOREG = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 20>
    {
      "HIDIdleTime" = 754000000000
      "HIDParameters" = {"HIDDefaultParameters"=Yes}
    }
`;

describe('idle detection', () => {
  it('parses HIDIdleTime nanoseconds', () => {
    expect(parseHidIdleSeconds(IOREG)).toBe(754);
    expect(parseHidIdleSeconds('no idle here')).toBeNull();
  });

  it('runs ioreg only on macOS and survives failures', async () => {
    const run = vi.fn(async () => IOREG);
    expect(await readIdleSeconds({ run, platform: 'darwin' })).toBe(754);
    expect(run).toHaveBeenCalledWith('ioreg', ['-c', 'IOHIDSystem']);
    expect(await readIdleSeconds({ run, platform: 'linux' })).toBeNull();
    expect(await readIdleSeconds({ run: async () => { throw new Error('ENOENT'); }, platform: 'darwin' })).toBeNull();
  });
});

describe('routing', () => {
  it('swaps macOS for the away channels while away', () => {
    const pref = { enabled: true, channels: ['macos' as const] };
    expect(selectChannels({ pref, away: false, awayChannels: ['webpush', 'slack_dm'] })).toEqual(['macos']);
    expect(selectChannels({ pref, away: true, awayChannels: ['webpush', 'slack_dm'] })).toEqual(['webpush', 'slack_dm']);
    expect(selectChannels({ pref: { enabled: true, channels: ['macos', 'webpush'] }, away: true, awayChannels: ['slack_dm'] })).toEqual(['webpush', 'slack_dm']);
    expect(selectChannels({ pref: { enabled: false, channels: ['macos'] }, away: true, awayChannels: ['webpush'] })).toEqual([]);
  });

  it('routes P2 notifier deliveries through the away channels', async () => {
    const cfg = OrcConfig.parse({ away: { channels: ['webpush'] } });
    const n = createNotifier({ config: () => cfg, debounceMs: 0 });
    const sent: string[] = [];
    const ch = (id: NotifyChannelImpl['id']): NotifyChannelImpl => ({ id, send: async () => { sent.push(id); } });
    n.register(ch('macos'));
    n.register(ch('webpush'));
    n.register(ch('slack_dm'));
    await n.notify(makeInboxItem({ id: 'a', dedupeKey: 'waiting:claude:a' }));
    n.setAway(true);
    await n.notify(makeInboxItem({ id: 'b', dedupeKey: 'waiting:claude:b' }));
    expect(sent).toEqual(['macos', 'webpush']);
  });
});

describe('away service', () => {
  it('follows idle time in auto mode and manual overrides', async () => {
    let idle: number | null = 30;
    const cfg = OrcConfig.parse({ away: { idleMinutes: 10 } });
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.on('away.changed', (e) => events.push(e));
    const setAway = vi.fn();
    const away = createAwayService({
      config: () => cfg,
      notifier: { notify: async () => {}, register: () => {}, setAway, isAway: () => false },
      bus,
      idle: async () => idle,
    });
    expect(await away.tick()).toEqual({ away: false, mode: 'auto', reason: 'present', idleSeconds: 30 });
    idle = 600;
    expect((await away.tick()).away).toBe(true);
    expect(await away.setMode('off')).toMatchObject({ away: false, reason: 'manual' });
    expect(await away.setMode('on')).toMatchObject({ away: true, reason: 'manual' });
    idle = null;
    expect(await away.setMode('auto')).toMatchObject({ away: false, reason: 'present', idleSeconds: null });
    expect(setAway.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(events.map((e) => (e.type === 'away.changed' ? `${e.away}:${e.reason}` : ''))).toEqual([
      'true:idle', 'false:manual', 'true:manual', 'false:present',
    ]);
  });
});

describe('away routes', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  it('reads and sets the mode, audited', async () => {
    const { ctx, audit, notifier } = p6Context();
    cleanups.push(() => ctx.dispose());
    const away = createAwayService({ config: ctx.config, notifier, bus: ctx.bus, idle: async () => 0 });
    const app = p6TestApp();
    registerAwayRoutes(app, ctx, { away });
    expect(await (await send(app, 'GET', '/api/remote/away')).json()).toMatchObject({ away: false, mode: 'auto' });
    const res = await send(app, 'POST', '/api/remote/away', { mode: 'on' }, { 'x-test-remote': 'd1' });
    expect(await res.json()).toMatchObject({ away: true, mode: 'on' });
    expect(notifier.isAway()).toBe(true);
    expect(audit.list({ action: 'away.set' })[0]).toMatchObject({ actor: 'remote', params: { mode: 'on' } });
    expect((await send(app, 'POST', '/api/remote/away', { mode: 'sometimes' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/remote/away.test.ts`
Expected: FAIL, `Cannot find module './idle.ts'`

- [ ] **Step 3: Implement idle detection, routing, the service and the route**

In `apps/daemon/src/remote/tailscale.ts`, rename `defaultRun` to an exported `runCommand` and update its two uses:
```ts
export const runCommand: RunCommand = async (cmd, args) => (await execa(cmd, args, { timeout: 5000 })).stdout;
```

`apps/daemon/src/remote/idle.ts`
```ts
import { type RunCommand, runCommand } from './tailscale.ts';

/** `ioreg -c IOHIDSystem` prints `"HIDIdleTime" = <nanoseconds since last keyboard/mouse input>`. */
export function parseHidIdleSeconds(ioregOutput: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput);
  return m?.[1] ? Math.floor(Number(m[1]) / 1e9) : null;
}

export async function readIdleSeconds(o: { run?: RunCommand; platform?: NodeJS.Platform } = {}): Promise<number | null> {
  if ((o.platform ?? process.platform) !== 'darwin') return null;
  try {
    return parseHidIdleSeconds(await (o.run ?? runCommand)('ioreg', ['-c', 'IOHIDSystem']));
  } catch {
    return null;
  }
}
```

`apps/daemon/src/notify/routing.ts`
```ts
import type { NotifyChannel, NotifyPref } from './notifier.ts';

export function selectChannels(i: { pref: NotifyPref; away: boolean; awayChannels: NotifyChannel[] }): NotifyChannel[] {
  if (!i.pref.enabled) return [];
  const out = new Set<NotifyChannel>(i.pref.channels);
  if (i.away) {
    out.delete('macos');
    for (const c of i.awayChannels) out.add(c);
  }
  return [...out];
}
```

In `apps/daemon/src/notify/notifier.ts`, inside `createNotifier().notify`, make two changes:
1. Change the early return to `if (!pref.enabled) return;`.
2. Replace the `for (const id of pref.channels) { if (away && id === 'macos') continue; … }` loop header with:
```ts
      for (const id of selectChannels({ pref, away, awayChannels: cfg.away.channels })) {
        const ch = channels.get(id);
        if (!ch) continue;
```
Keep the existing `try { await ch.send(item, url) } catch { … }` body, and add `import { selectChannels } from './routing.ts';`.

`apps/daemon/src/remote/away.ts`
```ts
import type { AwayMode, AwayState, OrcConfig } from '@orc/api-contract';
import type { EventBus } from '../live/event-bus.ts';
import type { Notifier } from '../notify/notifier.ts';
import { readIdleSeconds } from './idle.ts';

export interface AwayService {
  state(): AwayState;
  setMode(mode: AwayMode): Promise<AwayState>;
  tick(): Promise<AwayState>;
  start(): void;
  stop(): void;
}

export function createAwayService(d: {
  config: () => OrcConfig;
  notifier: Notifier;
  bus: EventBus;
  idle?: () => Promise<number | null>;
  intervalMs?: number;
}): AwayService {
  const idle = d.idle ?? (() => readIdleSeconds());
  let mode: AwayMode = 'auto';
  let current: AwayState = { away: false, mode, reason: 'present', idleSeconds: null };
  let timer: NodeJS.Timeout | null = null;

  function apply(next: AwayState): AwayState {
    const changed = next.away !== current.away;
    current = next;
    if (changed) {
      d.notifier.setAway(next.away);
      d.bus.emit({ type: 'away.changed', away: next.away, reason: next.reason });
    }
    return current;
  }

  async function evaluate(): Promise<AwayState> {
    if (mode === 'on') return apply({ away: true, mode, reason: 'manual', idleSeconds: current.idleSeconds });
    if (mode === 'off') return apply({ away: false, mode, reason: 'manual', idleSeconds: current.idleSeconds });
    const cfg = d.config().away;
    const secs = cfg.auto ? await idle() : null;
    const away = secs !== null && secs >= cfg.idleMinutes * 60;
    return apply({ away, mode, reason: away ? 'idle' : 'present', idleSeconds: secs });
  }

  return {
    state: () => current,
    async setMode(m) {
      mode = m;
      return evaluate();
    },
    tick: evaluate,
    start() {
      if (timer) return;
      void evaluate();
      timer = setInterval(() => void evaluate(), d.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

`apps/daemon/src/http/routes/away.ts`
```ts
import { AwayBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import type { AwayService } from '../../remote/away.ts';
import { readJson } from '../json.ts';
import { need, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export function registerAwayRoutes(app: OrcApp, ctx: DaemonContext, d: { away: AwayService }): void {
  app.get('/api/remote/away', (c) => c.json(d.away.state()));

  app.post('/api/remote/away', async (c) => {
    const { mode } = await readJson(c, AwayBody);
    const state = await d.away.setMode(mode);
    need(ctx.audit, 'audit').record({
      ...whoOf(c), action: 'away.set', target: null, params: { mode, away: state.away }, result: 'ok', error: null,
    });
    return c.json(state);
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/remote apps/daemon/src/notify`
Expected: PASS (6 new tests). P2's notifier tests still pass: while away, `macos` is still suppressed and unregistered channels are still skipped.

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green, including a full `pnpm typecheck` now that every Task 2 stub has been replaced (Tasks 4, 5, 6, 9, 13, 17).

```bash
git add apps/daemon
git commit -m "feat(daemon): add away mode with macOS idle detection and away notification routing"
```

---

### Task 18: Web — PWA shell, service worker push, device token and step-up client, pairing page

**Files:**
- Modify: `apps/web/package.json` (`vite-plugin-pwa`, `workbox-precaching`, `workbox-build`, `workbox-window`, `@simplewebauthn/browser`), `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api/client.ts`
- Create: `apps/web/tsconfig.sw.json`, `apps/web/src/sw.ts`
- Create: `apps/web/src/pwa/push-payload.ts`, `apps/web/src/pwa/push.ts`, `apps/web/src/pwa/register.ts`
- Create: `apps/web/src/api/token.ts`, `apps/web/src/api/step-up.ts`
- Create: `apps/web/src/features/remote/PairPage.tsx`, `apps/web/src/routes/pair.tsx`
- Create: `apps/web/src/pwa/pwa.test.ts`, `apps/web/src/features/remote/PairPage.test.tsx`
- Create: `apps/web/public/icons/logo.svg` (+ generated icon PNGs)

**Interfaces:**
- Consumes:
  - `vite-plugin-pwa@^1.3.0` `VitePWA({ strategies: 'injectManifest', srcDir, filename, injectRegister, registerType, manifest, injectManifest, devOptions })` and the `virtual:pwa-register` module (types from `vite-plugin-pwa/client`)
  - `workbox-precaching@^7.4.1` `precacheAndRoute`, `cleanupOutdatedCaches`
  - `@simplewebauthn/browser@^14.0.0` `startRegistration({ optionsJSON })`, `startAuthentication({ optionsJSON })`
  - P1 `getApiClient`, `setApiClientForTests`, `getToken`
  - Phase 6 client methods (Task 2)
- Produces:
  ```ts
  // api/token.ts
  export const DEVICE_TOKEN_KEY = 'orc.deviceToken';
  export function isLoopbackOrigin(hostname?: string): boolean
  export function readDeviceToken(): string | null
  export function setDeviceToken(token: string): void
  export function clearDeviceToken(): void
  export function resolveToken(): string            // window.__ORC_TOKEN__ ?? localStorage device token ?? ''
  // api/client.ts (modified)
  export function getToken(): string                // now returns resolveToken()
  export function resetApiClient(): void            // rebuilds the client after the token changes
  // api/step-up.ts
  export function performStepUp(): Promise<void>
  export function withStepUp<T>(fn: () => Promise<T>, stepUp?: () => Promise<void>): Promise<T>
  // pwa/push-payload.ts (also used by the service worker; no DOM APIs beyond atob)
  export interface PushMessage { title: string; body: string; url: string; tag: string }
  export function parsePushPayload(raw: string | null, fallbackUrl?: string): PushMessage
  export function urlBase64ToUint8Array(base64: string): Uint8Array
  // pwa/push.ts
  export type PushSetupResult = 'subscribed' | 'denied' | 'unsupported';
  export function enablePush(): Promise<PushSetupResult>
  export function disablePush(): Promise<void>
  // pwa/register.ts
  export function registerServiceWorker(): void
  // features/remote/PairPage.tsx
  export function defaultDeviceName(): string
  export function PairPage(props?: { registerPasskey?: () => Promise<void>; setupPush?: () => Promise<PushSetupResult> }): JSX.Element
  ```
- Behaviour:
  - The service worker precaches only static build assets. It never caches `/api/*`, and it stores no transcript text.
  - `push` shows a notification built from the payload; `notificationclick` focuses an open window and navigates it, or opens a new one.
  - The pairing page runs three steps: redeem the code → create the passkey → enable push. The device token is stored in `localStorage` and the API client is rebuilt.
  - Passkeys are created on the Tailscale origin (the pairing page is only reachable there), which is what makes the step-up work later.

- [ ] **Step 1: Install and write the failing tests**

Run: `pnpm --filter @orc/web add @simplewebauthn/browser@^14.0.0 workbox-precaching@^7.4.1 && pnpm --filter @orc/web add -D vite-plugin-pwa@^1.3.0 workbox-build@^7.4.1 workbox-window@^7.4.1`

`apps/web/src/pwa/pwa.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStepUp } from '../api/step-up.ts';
import { clearDeviceToken, isLoopbackOrigin, readDeviceToken, resolveToken, setDeviceToken } from '../api/token.ts';
import { parsePushPayload, urlBase64ToUint8Array } from './push-payload.ts';

describe('device token', () => {
  afterEach(() => {
    clearDeviceToken();
    window.__ORC_TOKEN__ = undefined;
  });

  it('prefers the injected token and falls back to the paired device token', () => {
    expect(resolveToken()).toBe('');
    setDeviceToken('device-token-1');
    expect(readDeviceToken()).toBe('device-token-1');
    expect(resolveToken()).toBe('device-token-1');
    window.__ORC_TOKEN__ = 'install-token';
    expect(resolveToken()).toBe('install-token');
    window.__ORC_TOKEN__ = null;
    expect(resolveToken()).toBe('device-token-1');
    clearDeviceToken();
    expect(resolveToken()).toBe('');
  });

  it('knows a loopback origin', () => {
    expect(isLoopbackOrigin('127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('localhost')).toBe(true);
    expect(isLoopbackOrigin('mac.tail1234.ts.net')).toBe(false);
  });
});

describe('withStepUp', () => {
  it('retries once after a passkey assertion', async () => {
    const stepUpError = Object.assign(new Error('confirm with your passkey'), { status: 401, code: 'step_up_required' });
    const fn = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValueOnce('ok');
    const stepUp = vi.fn(async () => {});
    await expect(withStepUp(fn, stepUp)).resolves.toBe('ok');
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes other errors through and never loops', async () => {
    const other = Object.assign(new Error('nope'), { code: 'not_owned' });
    await expect(withStepUp(vi.fn().mockRejectedValue(other), vi.fn())).rejects.toBe(other);
    const stepUpError = Object.assign(new Error('again'), { code: 'step_up_required' });
    const fn = vi.fn().mockRejectedValue(stepUpError);
    await expect(withStepUp(fn, vi.fn(async () => {}))).rejects.toBe(stepUpError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('push payload', () => {
  it('parses payloads defensively', () => {
    expect(parsePushPayload(JSON.stringify({ title: 'Waiting for you', body: 'b', url: 'https://x/inbox', tag: 't' }))).toEqual({
      title: 'Waiting for you', body: 'b', url: 'https://x/inbox', tag: 't',
    });
    expect(parsePushPayload(null)).toMatchObject({ title: 'Orchestrator', url: '/inbox' });
    expect(parsePushPayload('not json')).toMatchObject({ title: 'Orchestrator', body: 'not json' });
    expect(parsePushPayload('{"title":5}')).toMatchObject({ title: 'Orchestrator' });
  });

  it('decodes a VAPID key', () => {
    expect(urlBase64ToUint8Array('BPUB-_8')).toBeInstanceOf(Uint8Array);
    expect(urlBase64ToUint8Array('AAAA').length).toBe(3);
  });
});
```

`apps/web/src/features/remote/PairPage.test.tsx`
```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { clearDeviceToken, readDeviceToken } from '../../api/token.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { PairPage } from './PairPage.tsx';

describe('PairPage', () => {
  afterEach(() => {
    setApiClientForTests(null);
    clearDeviceToken();
  });

  it('redeems the code, registers a passkey and enables push', async () => {
    const remotePair = vi.fn(async () => ({ deviceId: 'd1', deviceToken: 'device-token-1' }));
    setApiClientForTests(fakeApi({ remotePair }));
    const registerPasskey = vi.fn(async () => {});
    const setupPush = vi.fn(async () => 'subscribed' as const);
    renderWithClient(<PairPage registerPasskey={registerPasskey} setupPush={setupPush} />);

    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'abcd2345' } });
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'My phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    await waitFor(() => expect(remotePair).toHaveBeenCalledWith('ABCD2345', 'My phone'));
    expect(readDeviceToken()).toBe('device-token-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Create passkey' }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Enable notifications' }));
    await waitFor(() => expect(setupPush).toHaveBeenCalled());
    expect(await screen.findByRole('link', { name: 'Open the inbox' })).toBeTruthy();
  });

  it('shows pairing errors and keeps no token', async () => {
    setApiClientForTests(
      fakeApi({ remotePair: vi.fn(async () => Promise.reject(Object.assign(new Error('wrong or expired pairing code'), { code: 'invalid_code' }))) }),
    );
    renderWithClient(<PairPage registerPasskey={vi.fn()} setupPush={vi.fn(async () => 'denied' as const)} />);
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'ZZZZZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    expect((await screen.findByRole('alert')).textContent).toContain('wrong or expired pairing code');
    expect(readDeviceToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/pwa apps/web/src/features/remote`
Expected: FAIL, `Cannot find module '../api/token.ts'`

- [ ] **Step 3: Implement the token, step-up and push helpers**

`apps/web/src/api/token.ts`
```ts
export const DEVICE_TOKEN_KEY = 'orc.deviceToken';

declare global {
  interface Window {
    __ORC_TOKEN__?: string | null;
  }
}

export function isLoopbackOrigin(hostname: string = window.location.hostname): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

export function readDeviceToken(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null; // private mode or blocked storage
  }
}

export function setDeviceToken(token: string): void {
  try {
    window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch {
    // storage unavailable; the token lives for this page only
  }
}

export function clearDeviceToken(): void {
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // nothing to clear
  }
}

/** The install token is injected by /bootstrap.js on the Mac; remote devices use their paired device token. */
export function resolveToken(): string {
  if (typeof window === 'undefined') return '';
  const injected = window.__ORC_TOKEN__;
  if (typeof injected === 'string' && injected !== '') return injected;
  return readDeviceToken() ?? '';
}
```

In `apps/web/src/api/client.ts`, replace `getToken` and add a reset:
```ts
import { resolveToken } from './token.ts';

export function getToken(): string {
  return resolveToken();
}

export function resetApiClient(): void {
  client = null;
}
```
(The `declare global { interface Window { __ORC_TOKEN__?: string } }` block moves to `token.ts`; delete it here.)

`apps/web/src/api/step-up.ts`
```ts
import { isApiErrorWithCode } from '@orc/api-contract';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { startAuthentication } from '@simplewebauthn/browser';
import { getApiClient } from './client.ts';

export async function performStepUp(): Promise<void> {
  const api = getApiClient();
  const optionsJSON = await api.webauthnStepUpOptions<PublicKeyCredentialRequestOptionsJSON>();
  const assertion = await startAuthentication({ optionsJSON });
  await api.webauthnStepUpVerify(assertion);
}

/** Runs `fn`; on `step_up_required` it asks for the passkey once and retries exactly once. */
export async function withStepUp<T>(fn: () => Promise<T>, stepUp: () => Promise<void> = performStepUp): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isApiErrorWithCode(e, 'step_up_required')) throw e;
    await stepUp();
    return fn();
  }
}
```

`apps/web/src/pwa/push-payload.ts`
```ts
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v !== '' ? v : fallback);

export function parsePushPayload(raw: string | null, fallbackUrl = '/inbox'): PushMessage {
  const base: PushMessage = { title: 'Orchestrator', body: 'Something needs you', url: fallbackUrl, tag: 'orchestrator' };
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<PushMessage>;
    return {
      title: str(v.title, base.title),
      body: str(v.body, base.body),
      url: str(v.url, base.url),
      tag: str(v.tag, base.tag),
    };
  } catch {
    return { ...base, body: raw.slice(0, 180) };
  }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
```

`apps/web/src/pwa/push.ts`
```ts
import { getApiClient } from '../api/client.ts';
import { urlBase64ToUint8Array } from './push-payload.ts';

export type PushSetupResult = 'subscribed' | 'denied' | 'unsupported';

export async function enablePush(): Promise<PushSetupResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await getApiClient().pushPublicKey();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'unsupported';
  await getApiClient().pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return 'subscribed';
}

export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await getApiClient().pushUnsubscribe(subscription.endpoint);
  await subscription.unsubscribe();
}
```

`apps/web/src/pwa/register.ts`
```ts
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  registerSW({
    immediate: true,
    onRegisterError(error: unknown) {
      console.warn('service worker registration failed', error);
    },
  });
}
```

- [ ] **Step 4: Write the service worker and the PWA build config**

`apps/web/src/sw.ts`
```ts
/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { parsePushPayload } from './pwa/push-payload.ts';

const sw = self as unknown as ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Static build assets only: no /api responses and no transcript text are ever cached.
precacheAndRoute(sw.__WB_MANIFEST);
cleanupOutdatedCaches();

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
  const message = parsePushPayload(event.data ? event.data.text() : null);
  event.waitUntil(
    sw.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      data: { url: message.url },
      icon: '/icons/pwa-192x192.png',
      badge: '/icons/pwa-64x64.png',
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url ?? '/inbox';
  event.waitUntil(
    (async () => {
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients[0];
      if (client) {
        await client.focus();
        await client.navigate(target);
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
```

`apps/web/tsconfig.sw.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "WebWorker"], "types": [], "moduleResolution": "bundler", "noEmit": true },
  "include": ["src/sw.ts", "src/pwa/push-payload.ts"]
}
```

In `apps/web/tsconfig.json`: add `"vite-plugin-pwa/client"` to `compilerOptions.types` and `"exclude": ["src/sw.ts"]`.
In `apps/web/package.json`: change the typecheck script to `"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.sw.json"`.

In `apps/web/vite.config.ts`: add `import { VitePWA } from 'vite-plugin-pwa';` and this plugin after `tailwindcss()`:
```ts
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Orchestrator',
        short_name: 'Orchestrator',
        description: 'Local-first command centre for AI coding agents',
        start_url: '/inbox',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0f19',
        theme_color: '#0b0f19',
        icons: [
          { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
      devOptions: { enabled: false },
    }),
```

In `apps/web/index.html`, add inside `<head>`:
```html
    <meta name="theme-color" content="#0b0f19" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180x180.png" />
```

In `apps/web/src/main.tsx`, add `import { registerServiceWorker } from './pwa/register.ts';` and call `registerServiceWorker();` after `createRoot(...).render(...)`.

`apps/web/public/icons/logo.svg`
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Orchestrator">
  <rect width="512" height="512" rx="96" fill="#0b0f19" />
  <circle cx="256" cy="150" r="46" fill="#38bdf8" />
  <circle cx="146" cy="340" r="46" fill="#a78bfa" />
  <circle cx="366" cy="340" r="46" fill="#34d399" />
  <path d="M256 196 L166 300 M256 196 L346 300 M180 356 h152" stroke="#e2e8f0" stroke-width="18" stroke-linecap="round" fill="none" />
</svg>
```

Generate the icons (writes `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png` and `favicon.ico` next to the SVG):
```bash
pnpm dlx @vite-pwa/assets-generator@^1.0.0 --preset minimal-2023 apps/web/public/icons/logo.svg
```
Expected: six files in `apps/web/public/icons/`. Commit them.

- [ ] **Step 5: Write the pairing page**

`apps/web/src/features/remote/PairPage.tsx`
```tsx
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getApiClient, resetApiClient } from '../../api/client.ts';
import { setDeviceToken } from '../../api/token.ts';
import { type PushSetupResult, enablePush } from '../../pwa/push.ts';

type Step = 'code' | 'passkey' | 'push' | 'done';

export function defaultDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Device';
}

async function registerPasskeyDefault(): Promise<void> {
  const api = getApiClient();
  const optionsJSON = await api.webauthnRegisterOptions<PublicKeyCredentialCreationOptionsJSON>();
  const attestation = await startRegistration({ optionsJSON });
  await api.webauthnRegisterVerify(attestation);
}

export function PairPage({
  registerPasskey = registerPasskeyDefault,
  setupPush = enablePush,
}: { registerPasskey?: () => Promise<void>; setupPush?: () => Promise<PushSetupResult> } = {}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName());
  const [step, setStep] = useState<Step>('code');
  const [pushResult, setPushResult] = useState<PushSetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm space-y-4 p-4">
      <h1 className="text-xl font-semibold">Pair this device</h1>
      {step === 'code' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(async () => {
              const r = await getApiClient().remotePair(code.trim().toUpperCase(), name.trim());
              setDeviceToken(r.deviceToken);
              resetApiClient();
              setStep('passkey');
            });
          }}
        >
          <p className="text-sm opacity-70">On the Mac, open Settings → Remote and create a pairing code.</p>
          <label className="block text-sm">
            Pairing code
            <input
              className="mt-1 w-full rounded border px-2 py-2 text-lg tracking-widest uppercase"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Device name
            <input className="mt-1 w-full rounded border px-2 py-2" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || code.trim().length !== 8 || name.trim() === ''}>
            Pair this device
          </Button>
        </form>
      )}
      {step === 'passkey' && (
        <div className="space-y-3">
          <p className="text-sm">Paired. Now create a passkey — it is required to send input, approve, stop or merge from here.</p>
          <Button disabled={busy} onClick={() => void guard(async () => { await registerPasskey(); setStep('push'); })}>
            Create passkey
          </Button>
        </div>
      )}
      {step === 'push' && (
        <div className="space-y-3">
          <p className="text-sm">Allow notifications so the inbox can reach you. On iOS, add this app to the Home Screen first.</p>
          <Button disabled={busy} onClick={() => void guard(async () => { setPushResult(await setupPush()); setStep('done'); })}>
            Enable notifications
          </Button>
          <Button variant="ghost" onClick={() => setStep('done')}>
            Skip
          </Button>
        </div>
      )}
      {step === 'done' && (
        <div className="space-y-3">
          <p className="text-sm">
            This device is ready{pushResult === 'subscribed' ? ' and notifications are on' : pushResult ? ` (notifications: ${pushResult})` : ''}.
          </p>
          <a className="underline" href="/inbox">
            Open the inbox
          </a>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </main>
  );
}
```

`apps/web/src/routes/pair.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PairPage } from '../features/remote/PairPage.tsx';

export const Route = createFileRoute('/pair')({ component: () => <PairPage /> });
```

- [ ] **Step 6: Run the tests and the build**

Run: `pnpm vitest run apps/web/src/pwa apps/web/src/features/remote && pnpm --filter @orc/web build && pnpm --filter @orc/web typecheck`
Expected: tests PASS (6 + 2); the build writes `apps/web/dist/sw.js` and `apps/web/dist/manifest.webmanifest`; typecheck passes for both tsconfigs.

Check the built worker by hand:
```bash
grep -c "precacheAndRoute\|notificationclick" apps/web/dist/sw.js
grep -o '"start_url":"[^"]*"' apps/web/dist/manifest.webmanifest
```
Expected: the grep count is at least 1, and `start_url` is `/inbox`.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add installable PWA, push service worker, device token and pairing page"
```

---

### Task 19: Web — mobile layouts, reply composer, read-only diff and Settings → Remote

**Files:**
- Create: `apps/web/src/api/queries/remote.ts`
- Create: `apps/web/src/features/mobile/useIsMobile.ts`, `MobileNav.tsx`, `ReplyComposer.tsx`, `InboxItemMobileCard.tsx`, `ReadOnlyDiff.tsx`, `mobile.test.tsx`
- Create: `apps/web/src/features/remote/RemotePanel.tsx`, `apps/web/src/features/remote/RemotePanel.test.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx`, `apps/web/src/features/inbox/InboxPage.tsx`, `apps/web/src/features/session-detail/SessionHeader.tsx`, `apps/web/src/features/review/ReviewPage.tsx`, `apps/web/src/features/settings/SettingsPage.tsx`
- Create: `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: Phase 6 client methods; `withStepUp` (Task 18); `useIsMobile`; P2 `useInbox`, `useLiveEvents`, `AppShell`; P3 `hotkeys` registry; `Session`, `InboxItem` types
- Produces:
  ```ts
  // api/queries/remote.ts
  export function useRemoteStatus(): UseQueryResult<RemoteStatus>
  export function useRemoteDevices(): UseQueryResult<RemoteDevice[]>
  export function useAway(): UseQueryResult<AwayState>
  export function useSetAway(): UseMutationResult<AwayState, Error, AwayMode>
  export function useSaveRemoteConfig(): UseMutationResult<RemoteStatus, Error, RemoteConfigBody>
  export function useCreatePairingCode(): UseMutationResult<PairingCode, Error, void>
  export function useRevokeDevice(): UseMutationResult<{ ok: true }, Error, string>
  // features/mobile/*
  export function useIsMobile(): boolean                      // matchMedia('(max-width: 767px)')
  export function MobileNav(): JSX.Element
  export function ReplyComposer(props: { session: Session }): JSX.Element
  export function InboxItemMobileCard(props: { item: InboxItem }): JSX.Element
  export function ReadOnlyDiff(props: { unified: string }): JSX.Element
  // features/remote/RemotePanel.tsx
  export function RemotePanel(): JSX.Element
  ```
  Query keys: `['remote-status']`, `['remote-devices']`, `['away']`.
- Behaviour:
  - Mobile is `max-width: 767px`. On mobile, `AppShell` hides the left nav and the terminal dock and renders `MobileNav` (Inbox, Live, Settings) as a bottom bar with a safe-area inset.
  - The reply composer only appears for **owned** sessions. Sending goes through `withStepUp`, so a remote device is asked for the passkey once.
  - Inbox cards on mobile expose Approve (step-up), Snooze 1h, Done and Reply.
  - The review screen on mobile renders `ReadOnlyDiff` and hides the comment composer and the ship panel.
  - Settings → Remote shows the status, the config form, pairing codes, paired devices with revoke, the away mode and a push test.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/mobile/mobile.test.tsx`
```tsx
import type { Session } from '@orc/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, makeSession, renderWithClient } from '../../test/query.tsx';
import { ReadOnlyDiff } from './ReadOnlyDiff.tsx';
import { ReplyComposer } from './ReplyComposer.tsx';

const owned = (): Session =>
  makeSession({
    id: 's1',
    live: { status: 'waiting', ownership: 'owned', ptyId: 'pty-1', waitingFor: 'Proceed?' },
  });

describe('ReplyComposer', () => {
  afterEach(() => setApiClientForTests(null));

  it('sends a reply and retries once after a step-up', async () => {
    const stepUpError = Object.assign(new Error('confirm with your passkey'), { code: 'step_up_required' });
    const sessionsReply = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValueOnce({ ok: true });
    const webauthnStepUpOptions = vi.fn(async () => ({ challenge: 'c' }));
    const webauthnStepUpVerify = vi.fn(async () => ({ validUntil: 'x' }));
    setApiClientForTests(fakeApi({ sessionsReply, webauthnStepUpOptions, webauthnStepUpVerify }));
    const stepUp = vi.fn(async () => {});
    renderWithClient(<ReplyComposer session={owned()} stepUp={stepUp} />);
    fireEvent.change(screen.getByLabelText('Reply to this session'), { target: { value: 'yes, continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sessionsReply).toHaveBeenCalledTimes(2));
    expect(sessionsReply).toHaveBeenLastCalledWith('claude', 's1', 'yes, continue');
    expect(stepUp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByLabelText('Reply to this session') as HTMLTextAreaElement).value).toBe(''));
  });

  it('explains why sending is off for observed sessions', () => {
    renderWithClient(<ReplyComposer session={makeSession({ id: 's2', live: { ownership: 'observed', ptyId: null } })} />);
    expect(screen.getByText(/not running in the app/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});

describe('ReadOnlyDiff', () => {
  it('marks added and removed lines and offers no editing', () => {
    renderWithClient(<ReadOnlyDiff unified={'@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n unchanged'} />);
    expect(screen.getByText('-const a = 1;').className).toContain('text-red');
    expect(screen.getByText('+const a = 2;').className).toContain('text-green');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
```

`apps/web/src/features/remote/RemotePanel.test.tsx`
```tsx
import type { AwayState, RemoteDevice, RemoteStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { RemotePanel } from './RemotePanel.tsx';

const status: RemoteStatus = {
  enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com', isRemote: false,
  deviceId: null, stepUpValidUntil: null, funnelDetected: false, pairingActiveUntil: null,
};
const device: RemoteDevice = {
  id: 'd1', name: 'iPhone', login: 'me@example.com', createdAt: '2026-09-17T10:00:00.000Z',
  lastSeenAt: null, revokedAt: null, credentials: 1,
};
const away: AwayState = { away: false, mode: 'auto', reason: 'present', idleSeconds: 12 };

describe('RemotePanel', () => {
  afterEach(() => {
    setApiClientForTests(null);
    vi.restoreAllMocks();
  });

  it('shows the pairing code and URL', async () => {
    const remoteCreatePairing = vi.fn(async () => ({ code: 'ABCD2345', expiresAt: '2026-09-17T10:05:00.000Z', url: 'https://mac.tail1234.ts.net/pair' }));
    setApiClientForTests(fakeApi({ remoteStatus: async () => status, remoteDevices: async () => [device], awayGet: async () => away, remoteCreatePairing }));
    renderWithClient(<RemotePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create pairing code' }));
    expect(await screen.findByText('ABCD2345')).toBeTruthy();
    expect(screen.getByText('https://mac.tail1234.ts.net/pair')).toBeTruthy();
  });

  it('revokes a device after confirmation and switches away mode', async () => {
    const remoteRevokeDevice = vi.fn(async () => ({ ok: true as const }));
    const awaySet = vi.fn(async () => ({ ...away, away: true, mode: 'on' as const, reason: 'manual' as const }));
    setApiClientForTests(fakeApi({ remoteStatus: async () => status, remoteDevices: async () => [device], awayGet: async () => away, remoteRevokeDevice, awaySet }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithClient(<RemotePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    await waitFor(() => expect(remoteRevokeDevice).toHaveBeenCalledWith('d1'));
    fireEvent.click(screen.getByRole('button', { name: 'Away now' }));
    await waitFor(() => expect(awaySet).toHaveBeenCalledWith('on'));
  });

  it('warns when a Funnel is detected', async () => {
    setApiClientForTests(
      fakeApi({ remoteStatus: async () => ({ ...status, funnelDetected: true }), remoteDevices: async () => [], awayGet: async () => away }),
    );
    renderWithClient(<RemotePanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Funnel');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/mobile apps/web/src/features/remote/RemotePanel.test.tsx`
Expected: FAIL, `Cannot find module './ReplyComposer.tsx'`

- [ ] **Step 3: Implement the query hooks**

`apps/web/src/api/queries/remote.ts`
```ts
import type { AwayMode, RemoteConfigBody } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useRemoteStatus() {
  return useQuery({ queryKey: ['remote-status'], queryFn: () => getApiClient().remoteStatus(), refetchInterval: 30_000 });
}

export function useRemoteDevices() {
  return useQuery({ queryKey: ['remote-devices'], queryFn: () => getApiClient().remoteDevices() });
}

export function useAway() {
  return useQuery({ queryKey: ['away'], queryFn: () => getApiClient().awayGet(), refetchInterval: 30_000 });
}

export function useSetAway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: AwayMode) => getApiClient().awaySet(mode),
    onSuccess: (state) => qc.setQueryData(['away'], state),
  });
}

export function useSaveRemoteConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RemoteConfigBody) => getApiClient().remoteSetConfig(body),
    onSuccess: (s) => qc.setQueryData(['remote-status'], s),
  });
}

export function useCreatePairingCode() {
  return useMutation({ mutationFn: () => getApiClient().remoteCreatePairing() });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().remoteRevokeDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['remote-devices'] }),
  });
}
```

- [ ] **Step 4: Implement the mobile components**

`apps/web/src/features/mobile/useIsMobile.ts`
```ts
import { useEffect, useState } from 'react';

export const MOBILE_QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
```

`apps/web/src/features/mobile/MobileNav.tsx`
```tsx
import { Link } from '@tanstack/react-router';

const ITEMS = [
  { to: '/inbox', label: 'Inbox' },
  { to: '/live', label: 'Live' },
  { to: '/settings', label: 'Settings' },
];

export function MobileNav() {
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-white pb-[env(safe-area-inset-bottom)] dark:bg-neutral-900 md:hidden"
    >
      {ITEMS.map((i) => (
        <Link key={i.to} to={i.to} className="flex-1 py-3 text-center text-sm" activeProps={{ className: 'font-semibold underline' }}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
```

`apps/web/src/features/mobile/ReplyComposer.tsx`
```tsx
import type { Session } from '@orc/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getApiClient } from '../../api/client.ts';
import { performStepUp, withStepUp } from '../../api/step-up.ts';

export function ReplyComposer({ session, stepUp = performStepUp }: { session: Session; stepUp?: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owned = session.live?.ownership === 'owned' && session.live.ptyId !== null;

  if (!owned) {
    return <p className="text-sm opacity-70">This session is not running in the app, so replies are off. Resume it here to take over.</p>;
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        void withStepUp(() => getApiClient().sessionsReply(session.source, session.id, text.trim()), stepUp)
          .then(() => setText(''))
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="block text-sm">
        Reply to this session
        <textarea
          className="mt-1 w-full rounded border px-2 py-2"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="yes, continue"
        />
      </label>
      <Button type="submit" disabled={busy || text.trim() === ''}>
        Send
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
```

`apps/web/src/features/mobile/InboxItemMobileCard.tsx`
```tsx
import type { InboxItem } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getApiClient } from '../../api/client.ts';
import { withStepUp } from '../../api/step-up.ts';

export function InboxItemMobileCard({ item }: { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = typeof item.payload.source === 'string' ? item.payload.source : null;
  const id = typeof item.payload.id === 'string' ? item.payload.id : item.sessionId;

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <article className="space-y-2 rounded-lg border p-3" aria-label={`Inbox item ${item.kind}`}>
      <header className="flex items-center justify-between text-sm">
        <span className="font-medium">{item.kind.replace(/_/g, ' ')}</span>
        <span className="opacity-60">{item.ticket ?? item.projectId ?? ''}</span>
      </header>
      <p className="text-sm">{item.reason}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => run(() => withStepUp(() => getApiClient().inboxApprove(item.id)))}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => getApiClient().inboxSnooze(item.id, new Date(Date.now() + 3_600_000).toISOString()))}>
          Snooze 1h
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => getApiClient().inboxDone(item.id))}>
          Done
        </Button>
        {source && id && (
          <Link to="/sessions/$source/$id" params={{ source, id }} className="text-sm underline">
            Open session
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </article>
  );
}
```

`apps/web/src/features/mobile/ReadOnlyDiff.tsx`
```tsx
const lineClass = (line: string): string => {
  if (line.startsWith('+')) return 'text-green-700 dark:text-green-400';
  if (line.startsWith('-')) return 'text-red-700 dark:text-red-400';
  if (line.startsWith('@@')) return 'text-sky-700 dark:text-sky-400';
  return 'opacity-80';
};

/** Read-only diff for phones: no inline comments, no revert, no staging. */
export function ReadOnlyDiff({ unified }: { unified: string }) {
  return (
    <pre className="overflow-x-auto rounded border p-2 text-xs leading-5">
      {unified.split('\n').map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
        <div key={i} className={lineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 5: Implement the Remote settings panel**

`apps/web/src/features/remote/RemotePanel.tsx`
```tsx
import type { RemoteDevice } from '@orc/api-contract';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getApiClient } from '../../api/client.ts';
import {
  useAway,
  useCreatePairingCode,
  useRemoteDevices,
  useRemoteStatus,
  useRevokeDevice,
  useSaveRemoteConfig,
  useSetAway,
} from '../../api/queries/remote.ts';

export function RemotePanel() {
  const status = useRemoteStatus();
  const devices = useRemoteDevices();
  const away = useAway();
  const setAway = useSetAway();
  const saveConfig = useSaveRemoteConfig();
  const pairing = useCreatePairingCode();
  const revoke = useRevokeDevice();
  const [origin, setOrigin] = useState('');
  const [login, setLogin] = useState('');
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  const s = status.data;
  const originValue = origin || (s?.origin ?? '');
  const loginValue = login || (s?.allowedLogin ?? '');

  return (
    <div className="space-y-4 text-sm">
      {s?.funnelDetected && (
        <p role="alert" className="rounded border border-red-500 p-2 text-red-700">
          Tailscale Funnel is enabled, so remote access is blocked. Run <code>tailscale funnel --https=443 off</code>.
        </p>
      )}
      <p>
        Remote access is <Badge variant={s?.enabled ? 'default' : 'secondary'}>{s?.enabled ? 'on' : 'off'}</Badge>{' '}
        {s?.origin ? `at ${s.origin}` : '(no Tailscale origin set)'}
      </p>
      <form
        className="grid gap-2 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveConfig.mutate({ enabled: true, origin: originValue.trim(), allowedLogin: loginValue.trim() });
        }}
      >
        <label className="block">
          Tailscale origin
          <Input value={originValue} onChange={(e) => setOrigin(e.target.value)} placeholder="https://mac.tail1234.ts.net" />
        </label>
        <label className="block">
          Tailscale login
          <Input value={loginValue} onChange={(e) => setLogin(e.target.value)} placeholder="me@example.com" />
        </label>
        <div className="md:col-span-2 flex gap-2">
          <Button type="submit" size="sm" disabled={saveConfig.isPending}>
            Save and enable
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!s?.enabled || pairing.isPending}
            onClick={() => pairing.mutate()}
          >
            Create pairing code
          </Button>
        </div>
      </form>
      {pairing.data && (
        <div className="rounded border p-3">
          <p className="text-2xl font-mono tracking-widest">{pairing.data.code}</p>
          <p className="opacity-70">
            Valid until {pairing.data.expiresAt}. On the phone open <span className="font-mono">{pairing.data.url}</span>
          </p>
        </div>
      )}

      <section aria-label="Paired devices" className="space-y-2">
        <h3 className="font-semibold">Paired devices</h3>
        {(devices.data ?? []).length === 0 && <p className="opacity-70">No devices paired yet.</p>}
        {(devices.data ?? []).map((d: RemoteDevice) => (
          <div key={d.id} className="flex items-center justify-between rounded border p-2">
            <span>
              {d.name} · {d.credentials} passkey{d.credentials === 1 ? '' : 's'} ·{' '}
              {d.revokedAt ? 'revoked' : `last seen ${d.lastSeenAt ?? 'never'}`}
            </span>
            {!d.revokedAt && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (window.confirm(`Revoke ${d.name}? It loses access, its passkeys and its push subscriptions.`)) revoke.mutate(d.id);
                }}
              >
                Revoke {d.name}
              </Button>
            )}
          </div>
        ))}
      </section>

      <section aria-label="Away mode" className="space-y-2">
        <h3 className="font-semibold">Away mode</h3>
        <p className="opacity-70">
          {away.data?.away ? 'Away' : 'At the Mac'} · mode {away.data?.mode} · reason {away.data?.reason}
          {away.data?.idleSeconds === null ? '' : ` · idle ${away.data?.idleSeconds}s`}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAway.mutate('auto')}>
            Automatic
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAway.mutate('on')}>
            Away now
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAway.mutate('off')}>
            At the Mac
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void getApiClient()
                .pushTest()
                .then((r) => setPushMessage(`sent to ${r.sent} device(s)`))
                .catch((e: unknown) => setPushMessage(e instanceof Error ? e.message : String(e)));
            }}
          >
            Send test push
          </Button>
        </div>
        {pushMessage && <p className="opacity-70">{pushMessage}</p>}
      </section>

      <p className="opacity-70">
        Setup steps are in <span className="font-mono">docs/setup-remote-and-connectors.md</span>. Never run{' '}
        <code>tailscale funnel</code>: it would expose the app to the internet.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Mount everything**

- `apps/web/src/features/shell/AppShell.tsx`: add
  ```tsx
  import { MobileNav } from '../mobile/MobileNav.tsx';
  import { useIsMobile } from '../mobile/useIsMobile.ts';
  ```
  then `const isMobile = useIsMobile();`, render the left `<nav>` and the terminal dock only when `!isMobile`, add `pb-16 md:pb-0` to the main content wrapper, and render `<MobileNav />` at the end when `isMobile`.
- `apps/web/src/features/inbox/InboxPage.tsx`: `const isMobile = useIsMobile();` and, when mobile, render `items.map((item) => <InboxItemMobileCard key={item.id} item={item} />)` instead of the table. The keyboard triage from P2/P3 (`hotkeys` registry) stays registered — it is simply unused on a phone.
- `apps/web/src/features/session-detail/SessionHeader.tsx`: render `<ReplyComposer session={session} />` under the actions row when `useIsMobile()` is true.
- `apps/web/src/features/review/ReviewPage.tsx`: `const isMobile = useIsMobile();`; when mobile, render `<ReadOnlyDiff unified={file.patch} />` for each file instead of `<FileDiff … />`, and skip the comment composer and the ship panel.
- `apps/web/src/features/settings/SettingsPage.tsx`: add
  ```tsx
  <section aria-labelledby="settings-remote">
    <h2 id="settings-remote" className="mb-3 text-lg font-semibold">Remote &amp; mobile</h2>
    <RemotePanel />
  </section>
  ```

- [ ] **Step 7: Write the mobile e2e spec**

`apps/web/e2e/mobile.spec.ts` (mirrors the daemon/e2e setup in P2's `live-inbox.spec.ts`; reuse its fixture/bootstrap import)
```ts
import { devices, expect, test } from '@playwright/test';

test.use({ ...devices['iPhone 14'] });

test('phone layout shows the inbox, the bottom nav and a reply composer', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' }).getByText('Live')).toBeVisible();
  const card = page.getByRole('article').first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Snooze 1h' })).toBeVisible();
  await card.getByRole('link', { name: 'Open session' }).click();
  await expect(page.getByLabel('Reply to this session')).toBeVisible();
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run apps/web/src/features && pnpm --filter @orc/web e2e -- mobile.spec.ts`
Expected: the unit tests PASS (5 new). The e2e spec passes against the fixture daemon; if the seeded inbox has no owned session, extend the P2 seed helper so one fixture session is owned, and note it in the review note.

- [ ] **Step 9: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add mobile layouts, reply composer, read-only diff and remote settings"
```

---

### Task 20: Wire Phase 6 into the daemon (`createPhase6`, routes, guard, WS, audit route list)

**Files:**
- Create: `apps/daemon/src/phase6.ts`, `apps/daemon/test/p6-daemon.test.ts`
- Modify: `apps/daemon/src/http/app.ts` (register Phase 6 routes before the `/api/*` 404), `apps/daemon/src/main.ts` (build and start Phase 6), `apps/daemon/src/http/ws.ts` (pass the guard deps), `apps/daemon/src/http/audit-middleware.ts` (`NON_ACTION_ROUTES`)

**Interfaces:**
- Consumes: every service from Tasks 4–17; P1 `createApp`, `createDaemon`, `attachPtyWebSocket`; P3 `NON_ACTION_ROUTES`
- Produces:
  ```ts
  // phase6.ts
  export interface Phase6Options { secrets?: SecretStore; linearApi?: (token: string) => LinearApi; slackApi?: (token: string | null) => SlackApi; pushSender?: PushSender; idle?: () => Promise<number | null>; run?: RunCommand }
  export interface Phase6 {
    secrets: SecretStore; linear: LinearConnector; slack: SlackConnector; share: ShareService; actions: SessionActions;
    bridge: SlackBridge; away: AwayService; devices: DeviceService; pairing: PairingService; stepUp: StepUpStore;
    funnel: FunnelWatch; webauthn: WebAuthnService; keys: VapidKeys; push: WebPushChannel; guardDeps: RemoteGuardDeps;
    register(app: OrcApp): void; start(): void; stop(): void;
  }
  export function createPhase6(ctx: DaemonContext, o?: Phase6Options): Phase6
  // http/app.ts
  export interface AppOptions { /* … */ remote?: RemoteGuardDeps | null; phase6?: { register(app: OrcApp): void } }
  ```
- Behaviour:
  - `createPhase6` builds every Phase 6 service, assigns `ctx.secrets`, `ctx.linear`, `ctx.slack`, `ctx.share`, `ctx.sessionActions` and `ctx.away`, and registers the `webpush` and `slack_dm` notify channels.
  - `start()` starts the Funnel watch, away mode, the Slack bridge and the three pollers. `stop()` stops them all. Every timer is `unref`'d, so the process can still exit.
  - `createApp` registers the Phase 6 routes **before** the `/api/*` 404 catch-all.
  - The WS upgrade listener gets the same guard deps.

- [ ] **Step 1: Write the failing wiring test**

`apps/daemon/test/p6-daemon.test.ts`
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.ts';
import { createPhase6 } from '../src/phase6.ts';
import { createMemorySecretStore } from '../src/services/secrets/secret-store.ts';
import { fakeLinearApi, fakeSlackApi } from './p6-connector-fakes.ts';
import { useTempHomes } from './helpers.ts';
import { p6Context } from './p6-fakes.ts';

const TOKEN = 'a'.repeat(64);
type Err = { error: { code: string } };

describe('phase 6 wiring', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function boot() {
    const { ctx, notifier } = p6Context();
    cleanups.push(() => ctx.dispose());
    const secrets = createMemorySecretStore();
    const p6 = createPhase6(ctx, {
      secrets,
      linearApi: () => fakeLinearApi(),
      slackApi: () => fakeSlackApi(),
      pushSender: async () => ({ statusCode: 201 }),
      idle: async () => 0,
      run: async () => '{}',
    });
    cleanups.push(() => p6.stop());
    const app = createApp({ ctx, token: TOKEN, port: () => 4317, remote: p6.guardDeps, phase6: p6 });
    const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      app.request(
        `http://127.0.0.1:4317${path}`,
        { method, headers: { host: '127.0.0.1:4317', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      );
    return { ctx, notifier, p6, req };
  }

  it('exposes the phase 6 routes through createApp and fills the context', async () => {
    const b = boot();
    expect(b.ctx.secrets).toBeDefined();
    expect(b.ctx.linear).toBeDefined();
    expect(b.ctx.slack).toBeDefined();
    expect(b.ctx.share).toBeDefined();
    expect(b.ctx.sessionActions).toBeDefined();
    expect(b.ctx.away).toBeDefined();
    expect(b.notifier.channels.map((c) => c.id).sort()).toEqual(['slack_dm', 'webpush']);

    const list = await b.req('GET', '/api/connectors', { 'x-orc-token': TOKEN });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: 'linear', connected: false }),
      expect.objectContaining({ id: 'slack', connected: false }),
    ]);
    expect((await b.req('GET', '/api/remote/away', { 'x-orc-token': TOKEN })).status).toBe(200);
    expect((await b.req('GET', '/api/push/vapid-public-key', { 'x-orc-token': TOKEN })).status).toBe(200);
    expect((await b.req('GET', '/api/connectors', {})).status).toBe(401);
  });

  it('lets the OAuth callback through without a token but blocks remote requests while remote is off', async () => {
    const b = boot();
    const callback = await b.req('GET', '/api/connectors/slack/callback?error=access_denied');
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain('access_denied');
    const remote = await b.req('GET', '/api/live', {
      'x-forwarded-host': 'mac.tail1234.ts.net',
      'tailscale-user-login': 'me@example.com',
    });
    expect(remote.status).toBe(403);
    expect(((await remote.json()) as Err).error.code).toBe('remote_disabled');
  });

  it('starts and stops every background job without keeping the process alive', () => {
    const b = boot();
    b.p6.start();
    b.p6.stop();
    b.p6.stop();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/p6-daemon.test.ts`
Expected: FAIL, `Cannot find module '../src/phase6.ts'`

- [ ] **Step 3: Write `phase6.ts`**

`apps/daemon/src/phase6.ts`
```ts
import type { DaemonContext } from './context.ts';
import type { LinearApi } from './connectors/linear/api.ts';
import { createLinearAssignedPoller } from './connectors/linear/assigned-poller.ts';
import { type LinearConnector, createLinearConnector } from './connectors/linear/linear.ts';
import { createOAuthStateStore, slackOAuthProvider } from './connectors/oauth.ts';
import type { SlackApi } from './connectors/slack/api.ts';
import { createSlackMentionPoller } from './connectors/slack/mention-poller.ts';
import { type SlackConnector, createSlackConnector } from './connectors/slack/slack.ts';
import { createStreamEnricher, createStreamTitleStore } from './connectors/stream-enricher.ts';
import { registerAwayRoutes } from './http/routes/away.ts';
import { registerConnectorRoutes } from './http/routes/connectors.ts';
import { registerPushRoutes } from './http/routes/push.ts';
import { registerRemoteRoutes } from './http/routes/remote.ts';
import { registerSessionActionRoutes } from './http/routes/session-actions.ts';
import { registerShareRoutes } from './http/routes/share.ts';
import { registerWebAuthnRoutes } from './http/routes/webauthn.ts';
import { need } from './http/p6-util.ts';
import type { RemoteGuardDeps } from './http/remote-guard.ts';
import type { OrcApp } from './http/types.ts';
import { createSlackDmChannel } from './notify/slack-dm.ts';
import { type VapidKeys, loadOrCreateVapidKeys } from './notify/vapid.ts';
import { type PushSender, type WebPushChannel, createWebPushChannel } from './notify/webpush.ts';
import { type AwayService, createAwayService } from './remote/away.ts';
import { type DeviceService, createDeviceService } from './remote/devices.ts';
import { type PairingService, createPairingService } from './remote/pairing.ts';
import { type StepUpStore, createStepUpStore } from './remote/step-up.ts';
import { type FunnelWatch, type RunCommand, createFunnelWatch } from './remote/tailscale.ts';
import { type WebAuthnService, createWebAuthnService } from './remote/webauthn.ts';
import { type SecretStore, createSecretStore } from './services/secrets/secret-store.ts';
import { type SessionActions, createSessionActions } from './services/remote/session-actions.ts';
import { type SlackBridge, createSlackBridge } from './services/remote/slack-bridge.ts';
import { type ShareService, createShareService } from './services/share/share.ts';

export interface Phase6Options {
  secrets?: SecretStore;
  linearApi?: (token: string) => LinearApi;
  slackApi?: (token: string | null) => SlackApi;
  pushSender?: PushSender;
  idle?: () => Promise<number | null>;
  run?: RunCommand;
}

export interface Phase6 {
  secrets: SecretStore;
  linear: LinearConnector;
  slack: SlackConnector;
  share: ShareService;
  actions: SessionActions;
  bridge: SlackBridge;
  away: AwayService;
  devices: DeviceService;
  pairing: PairingService;
  stepUp: StepUpStore;
  funnel: FunnelWatch;
  webauthn: WebAuthnService;
  keys: VapidKeys;
  push: WebPushChannel;
  guardDeps: RemoteGuardDeps;
  register(app: OrcApp): void;
  start(): void;
  stop(): void;
}

export function createPhase6(ctx: DaemonContext, o: Phase6Options = {}): Phase6 {
  const secrets = o.secrets ?? createSecretStore();
  const linear = createLinearConnector({ secrets, ...(o.linearApi ? { api: o.linearApi } : {}) });
  const slack = createSlackConnector({ secrets, ...(o.slackApi ? { api: o.slackApi } : {}) });
  const share = createShareService({ ctx, linear, slack });
  const actions = createSessionActions(ctx);

  const devices = createDeviceService(ctx.db);
  const stepUp = createStepUpStore({ ttlMs: () => ctx.config().remote.stepUpTtlSec * 1000 });
  const pairing = createPairingService({ ttlMs: () => ctx.config().remote.pairingTtlSec * 1000 });
  const funnel = createFunnelWatch({ ...(o.run ? { run: o.run } : {}), log: ctx.log });
  const webauthn = createWebAuthnService({ db: ctx.db, config: ctx.config, devices, stepUp });

  const keys = loadOrCreateVapidKeys(ctx.paths.orcHome);
  const push = createWebPushChannel({ db: ctx.db, keys, config: ctx.config, log: ctx.log, ...(o.pushSender ? { send: o.pushSender } : {}) });
  const bridge = createSlackBridge({ ctx, slack, actions });
  const notifier = need(ctx.notifier, 'notifier');
  notifier.register(push);
  notifier.register(createSlackDmChannel(bridge));

  const away = createAwayService({ config: ctx.config, notifier, bus: ctx.bus, ...(o.idle ? { idle: o.idle } : {}) });
  const pollers = [
    createLinearAssignedPoller({ ctx, linear }),
    createSlackMentionPoller({ ctx, slack }),
    createStreamEnricher({ ctx, linear, store: createStreamTitleStore(ctx) }),
  ];

  ctx.secrets = secrets;
  ctx.linear = linear;
  ctx.slack = slack;
  ctx.share = share;
  ctx.sessionActions = actions;
  ctx.away = away;

  return {
    secrets, linear, slack, share, actions, bridge, away, devices, pairing, stepUp, funnel, webauthn, keys, push,
    guardDeps: { config: ctx.config, devices, stepUp, funnel },
    register(app) {
      registerConnectorRoutes(app, ctx, {
        secrets, linear, slack,
        providers: { slack: slackOAuthProvider() },
        oauthState: createOAuthStateStore(),
      });
      registerShareRoutes(app, ctx, { share, linear });
      registerSessionActionRoutes(app, ctx, { actions });
      registerRemoteRoutes(app, ctx, { devices, pairing, stepUp, funnel });
      registerWebAuthnRoutes(app, ctx, { webauthn });
      registerPushRoutes(app, ctx, { keys, channel: push });
      registerAwayRoutes(app, ctx, { away });
    },
    start() {
      funnel.start();
      away.start();
      bridge.start();
      for (const p of pollers) p.start();
    },
    stop() {
      funnel.stop();
      away.stop();
      bridge.stop();
      for (const p of pollers) p.stop();
    },
  };
}
```

- [ ] **Step 4: Wire it into the app, the daemon and the WS listener**

In `apps/daemon/src/http/app.ts`:
```ts
export interface AppOptions {
  // … existing fields
  remote?: RemoteGuardDeps | null;
  phase6?: { register(app: OrcApp): void };
}
```
and, right after the other `register…Routes(app, o.ctx)` calls and **before** `app.all('/api/*', …404…)`:
```ts
  o.phase6?.register(app);
```

In `apps/daemon/src/main.ts` → `createDaemon`:
```ts
import { type Phase6Options, createPhase6 } from './phase6.ts';
// createDaemon options gain:  phase6?: Phase6Options
// after every P1–P5 service is on ctx and before createApp:
  const phase6 = createPhase6(ctx, o.phase6 ?? {});
  const app = createApp({ ctx, token, port: () => port, webDist, remote: phase6.guardDeps, phase6 });
// in start(): after the HTTP server listens
  phase6.start();
  attachPtyWebSocket(server, { ctx, token, origins, remote: phase6.guardDeps });
// in close()/stop(): before closing the db
  phase6.stop();
```

In `apps/daemon/src/http/audit-middleware.ts`, extend `NON_ACTION_ROUTES` with the Phase 6 routes (each one is audited inside its service, or changes nothing outside this Mac):
```ts
  { method: 'POST', path: '/api/connectors/:id/token', why: 'audited in the route as connector.connect' },
  { method: 'POST', path: '/api/connectors/:id/app', why: 'audited as connector.configure' },
  { method: 'GET', path: '/api/connectors/:id/callback', why: 'OAuth redirect; the resulting connect is audited' },
  { method: 'DELETE', path: '/api/connectors/:id', why: 'audited as connector.disconnect' },
  { method: 'POST', path: '/api/linear/issues/:identifier/comment', why: 'audited in ShareService as linear.comment' },
  { method: 'POST', path: '/api/linear/follow-up', why: 'audited as linear.issue.create' },
  { method: 'POST', path: '/api/slack/post', why: 'audited as slack.post' },
  { method: 'POST', path: '/api/sessions/:source/:id/reply', why: 'audited by withPtyInputAudit as pty.input' },
  { method: 'POST', path: '/api/inbox/:id/approve', why: 'audited as remote.approve or inbox.approve' },
  { method: 'POST', path: '/api/remote/config', why: 'audited as remote.configure' },
  { method: 'POST', path: '/api/remote/pairing', why: 'audited as remote.pairing_code' },
  { method: 'POST', path: '/api/remote/pair', why: 'audited as remote.pair' },
  { method: 'DELETE', path: '/api/remote/devices/:id', why: 'audited as remote.revoke' },
  { method: 'POST', path: '/api/remote/away', why: 'audited as away.set' },
  { method: 'POST', path: '/api/webauthn/register/options', why: 'issues a challenge; no state change' },
  { method: 'POST', path: '/api/webauthn/register/verify', why: 'audited as webauthn.register' },
  { method: 'POST', path: '/api/webauthn/stepup/options', why: 'issues a challenge; no state change' },
  { method: 'POST', path: '/api/webauthn/stepup/verify', why: 'grants a step-up; the guarded action is audited' },
  { method: 'POST', path: '/api/push/subscriptions', why: 'device-local notification preference' },
  { method: 'DELETE', path: '/api/push/subscriptions', why: 'device-local notification preference' },
  { method: 'POST', path: '/api/push/test', why: 'sends a test notification only' },
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon`
Expected: PASS, including the 3 new wiring tests and P3's audit-route coverage test.

- [ ] **Step 6: Boot the real daemon once by hand**

Run:
```bash
ORC_HOME=/tmp/orc-p6 pnpm --filter @orc/daemon dev &
sleep 3
TOKEN=$(cat /tmp/orc-p6/token)
curl -s -H "x-orc-token: $TOKEN" http://127.0.0.1:4317/api/connectors | head -20
curl -s -H "x-orc-token: $TOKEN" http://127.0.0.1:4317/api/remote/status
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-Host: mac.example.ts.net' -H 'Tailscale-User-Login: me@example.com' http://127.0.0.1:4317/api/live
ls -l /tmp/orc-p6/vapid.json
kill %1
```
Expected: the connector list shows both connectors as not connected, `remote/status` shows `enabled: false`, the forged remote request answers `403`, and `vapid.json` exists with mode `-rw-------`. Paste the output into the review note.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): wire phase 6 connectors, remote access and notifications into the daemon"
```

---

### Task 21 (optional): Linear OAuth with refresh tokens

Skip this task if the pasted personal API key (Task 5) is enough. It only adds a second way to connect Linear, with a token that expires every 24 hours.

**Files:**
- Create: `apps/daemon/src/connectors/linear/oauth.ts`, `apps/daemon/src/connectors/refreshing-secrets.ts`, `apps/daemon/src/connectors/linear/oauth.test.ts`
- Modify: `apps/daemon/src/phase6.ts` (register the provider and wrap the Linear secrets)

**Interfaces:**
- Consumes: `OAuthProvider`, `OAuthTokens` (Task 7); `SecretStore` (Task 4); connector meta repo (Task 3)
- Produces:
  ```ts
  export const LINEAR_SCOPES = 'read,write';
  export function linearOAuthProvider(fetchImpl?: typeof fetch): OAuthProvider
  export function createRefreshingSecretStore(d: { inner: SecretStore; db: OrcDb; connector: ConnectorKey; provider: OAuthProvider; now?: () => number; skewMs?: number; log?: { warn(o: object, m?: string): void } }): SecretStore
  ```
- Behaviour (from Linear's OAuth docs, checked 2026-09-17):
  - Authorize: `https://linear.app/oauth/authorize?client_id&redirect_uri&response_type=code&scope=read,write&state&actor=user`. `actor=user` is what makes comments and issues appear **as me**.
  - Token: `POST https://api.linear.app/oauth/token`, form-encoded, `grant_type=authorization_code`. The response has `access_token`, `expires_in` (86399) and `refresh_token`.
  - Refresh: the same endpoint with `grant_type=refresh_token`.
  - `createRefreshingSecretStore` wraps the store the Linear connector reads. When the connector's auth kind is `oauth` and `cursor.tokenExpiresAt` is within `skewMs` (default 60 s), it refreshes once (single-flight), stores the new tokens and updates the cursor. On failure it marks the connector `unauthenticated` and returns the old token.
  - Linear accepts `http://localhost`-style redirect URLs, so `connectors.linear.redirectUri` works as it is.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/connectors/linear/oauth.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { p6Context } from '../../../test/p6-fakes.ts';
import { useTempHomes } from '../../../test/helpers.ts';
import { getConnectorMeta, setConnectorCursor, upsertConnectorMeta } from '../../db/repos/connectors.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { createRefreshingSecretStore } from '../refreshing-secrets.ts';
import { LINEAR_SCOPES, linearOAuthProvider } from './oauth.ts';

const tokenResponse = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: 'lin_oauth_new', refresh_token: 'refresh_2', expires_in: 86399, scope: 'read,write', ...over }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('linear oauth provider', () => {
  it('builds the authorize URL with actor=user', () => {
    const url = new URL(
      linearOAuthProvider().authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:4317/api/connectors/linear/callback', state: 'st' }),
    );
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('actor')).toBe('user');
    expect(url.searchParams.get('scope')).toBe(LINEAR_SCOPES);
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges and refreshes with form encoding', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse());
    const provider = linearOAuthProvider(fetchImpl as unknown as typeof fetch);
    const tokens = await provider.exchange({ clientId: 'cid', clientSecret: 'sec', code: 'abc', redirectUri: 'http://r' });
    expect(tokens).toEqual({ accessToken: 'lin_oauth_new', refreshToken: 'refresh_2', expiresInSec: 86399, accountId: null, scopes: ['read', 'write'] });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.linear.app/oauth/token');
    expect((init as RequestInit | undefined)?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(String((init as RequestInit | undefined)?.body)).toContain('grant_type=authorization_code');
    await provider.refresh?.({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'refresh_1' });
    expect(String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body)).toContain('grant_type=refresh_token');
  });

  it('reports HTTP failures', async () => {
    const provider = linearOAuthProvider((async () => new Response('bad code', { status: 400 })) as unknown as typeof fetch);
    await expect(provider.exchange({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' })).rejects.toThrow('Linear OAuth failed (400)');
  });
});

describe('refreshing secret store', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(authKind: 'oauth' | 'api_key', expiresAt: string | null) {
    const { ctx } = p6Context();
    cleanups.push(() => ctx.dispose());
    upsertConnectorMeta(ctx.db, { connector: 'linear', authKind, accountId: 'u1', accountLabel: 'me', scopes: [], connectedAt: '2026-09-17T00:00:00.000Z' });
    if (expiresAt) setConnectorCursor(ctx.db, 'linear', { tokenExpiresAt: expiresAt });
    const inner = createMemorySecretStore({
      'linear.token': 'lin_oauth_old', 'linear.refresh_token': 'refresh_1', 'linear.client_id': 'cid', 'linear.client_secret': 'sec',
    });
    const refresh = vi.fn(async () => ({ accessToken: 'lin_oauth_new', refreshToken: 'refresh_2', expiresInSec: 86399, accountId: null, scopes: [] }));
    const provider = { ...linearOAuthProvider(), refresh };
    const store = createRefreshingSecretStore({
      inner, db: ctx.db, connector: 'linear', provider, now: () => Date.parse('2026-09-17T12:00:00.000Z'),
    });
    return { ctx, inner, refresh, store };
  }

  it('refreshes an expiring OAuth token once and stores the result', async () => {
    const s = setup('oauth', '2026-09-17T12:00:30.000Z');
    const [a, b] = await Promise.all([s.store.get('linear.token'), s.store.get('linear.token')]);
    expect([a, b]).toEqual(['lin_oauth_new', 'lin_oauth_new']);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(await s.inner.get('linear.refresh_token')).toBe('refresh_2');
    expect(getConnectorMeta(s.ctx.db, 'linear')?.cursor.tokenExpiresAt).toBe('2026-09-18T11:59:59.000Z');
  });

  it('leaves fresh tokens and API keys alone', async () => {
    const fresh = setup('oauth', '2026-09-18T00:00:00.000Z');
    expect(await fresh.store.get('linear.token')).toBe('lin_oauth_old');
    const key = setup('api_key', null);
    expect(await key.store.get('linear.token')).toBe('lin_oauth_old');
    expect(fresh.refresh).not.toHaveBeenCalled();
    expect(key.refresh).not.toHaveBeenCalled();
  });

  it('keeps the old token and marks the connector when refreshing fails', async () => {
    const s = setup('oauth', '2026-09-17T12:00:30.000Z');
    s.refresh.mockRejectedValue(new Error('invalid_grant'));
    expect(await s.store.get('linear.token')).toBe('lin_oauth_old');
    expect(getConnectorMeta(s.ctx.db, 'linear')?.lastStatus).toBe('unauthenticated');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/connectors/linear/oauth.test.ts`
Expected: FAIL, `Cannot find module './oauth.ts'`

- [ ] **Step 3: Implement the provider and the refreshing store**

`apps/daemon/src/connectors/linear/oauth.ts`
```ts
import type { OAuthProvider, OAuthTokens } from '../oauth.ts';

export const LINEAR_SCOPES = 'read,write';

export function linearOAuthProvider(fetchImpl: typeof fetch = fetch): OAuthProvider {
  async function token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetchImpl('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Linear OAuth failed (${res.status}): ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string | string[] };
    if (!json.access_token) throw new Error('Linear returned no access token');
    const scopes = Array.isArray(json.scope) ? json.scope : (json.scope ?? '').split(',').filter((s) => s !== '');
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresInSec: typeof json.expires_in === 'number' ? json.expires_in : null,
      accountId: null,
      scopes,
    };
  }

  return {
    id: 'linear',
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL('https://linear.app/oauth/authorize');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', LINEAR_SCOPES);
      u.searchParams.set('state', state);
      u.searchParams.set('actor', 'user'); // issues and comments are created as me, not as the app
      return u.toString();
    },
    exchange: (i) =>
      token({ grant_type: 'authorization_code', code: i.code, redirect_uri: i.redirectUri, client_id: i.clientId, client_secret: i.clientSecret }),
    refresh: (i) => token({ grant_type: 'refresh_token', refresh_token: i.refreshToken, client_id: i.clientId, client_secret: i.clientSecret }),
  };
}
```

`apps/daemon/src/connectors/refreshing-secrets.ts`
```ts
import type { OrcDb } from '../db/client.ts';
import { type ConnectorKey, getConnectorMeta, setConnectorCursor, setConnectorStatus } from '../db/repos/connectors.ts';
import type { SecretStore } from '../services/secrets/secret-store.ts';
import type { OAuthProvider } from './oauth.ts';

/** Wraps a SecretStore so that `<connector>.token` is refreshed before it expires (OAuth connectors only). */
export function createRefreshingSecretStore(d: {
  inner: SecretStore;
  db: OrcDb;
  connector: ConnectorKey;
  provider: OAuthProvider;
  now?: () => number;
  skewMs?: number;
  log?: { warn(o: object, m?: string): void };
}): SecretStore {
  const now = d.now ?? Date.now;
  const skew = d.skewMs ?? 60_000;
  const tokenKey = `${d.connector}.token`;
  let inFlight: Promise<string | null> | null = null;

  async function refresh(): Promise<string | null> {
    const meta = getConnectorMeta(d.db, d.connector);
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      d.inner.get(`${d.connector}.client_id`),
      d.inner.get(`${d.connector}.client_secret`),
      d.inner.get(`${d.connector}.refresh_token`),
    ]);
    if (!meta || !clientId || !clientSecret || !refreshToken || !d.provider.refresh) return d.inner.get(tokenKey);
    try {
      const tokens = await d.provider.refresh({ clientId, clientSecret, refreshToken });
      await d.inner.set(tokenKey, tokens.accessToken);
      if (tokens.refreshToken) await d.inner.set(`${d.connector}.refresh_token`, tokens.refreshToken);
      setConnectorCursor(d.db, d.connector, {
        ...meta.cursor,
        tokenExpiresAt: tokens.expiresInSec ? new Date(now() + tokens.expiresInSec * 1000).toISOString() : null,
      });
      setConnectorStatus(d.db, d.connector, 'ok', new Date(now()).toISOString());
      return tokens.accessToken;
    } catch (err) {
      setConnectorStatus(d.db, d.connector, 'unauthenticated', new Date(now()).toISOString());
      d.log?.warn({ err: String(err), connector: d.connector }, 'OAuth token refresh failed');
      return d.inner.get(tokenKey);
    }
  }

  return {
    async get(key) {
      if (key !== tokenKey) return d.inner.get(key);
      const meta = getConnectorMeta(d.db, d.connector);
      const expiresAt = typeof meta?.cursor.tokenExpiresAt === 'string' ? Date.parse(meta.cursor.tokenExpiresAt) : null;
      if (meta?.authKind !== 'oauth' || expiresAt === null || Number.isNaN(expiresAt) || expiresAt - skew > now()) {
        return d.inner.get(key);
      }
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    set: (key, value) => d.inner.set(key, value),
    delete: (key) => d.inner.delete(key),
  };
}
```

- [ ] **Step 4: Use them in the wiring**

In `apps/daemon/src/phase6.ts`:
```ts
import { createRefreshingSecretStore } from './connectors/refreshing-secrets.ts';
import { linearOAuthProvider } from './connectors/linear/oauth.ts';
// …
  const linearProvider = linearOAuthProvider();
  const linearSecrets = createRefreshingSecretStore({
    inner: secrets, db: ctx.db, connector: 'linear', provider: linearProvider, log: ctx.log,
  });
  const linear = createLinearConnector({ secrets: linearSecrets, ...(o.linearApi ? { api: o.linearApi } : {}) });
// and in register():
        providers: { slack: slackOAuthProvider(), linear: linearProvider },
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/connectors apps/daemon/test/p6-daemon.test.ts`
Expected: PASS (6 new tests, and the wiring test still passes)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add optional Linear OAuth with refresh-token handling"
```

---

### Task 22: M6 exit — setup doc, manual evidence, contract merge, phase close

**Files:**
- Create: `docs/setup-remote-and-connectors.md`, `plan/phase-6-evidence.md`
- Modify: `plan/00-contracts.md` (merge the Contract additions), `plan/README.md` (status table)

**Interfaces:**
- Consumes: everything from Tasks 1–21
- Produces: the merged contracts, the operator setup doc and a filled-in evidence file. No code changes.

- [ ] **Step 1: Write the operator setup doc**

`docs/setup-remote-and-connectors.md`: copy the **Operator setup** section from the top of this plan verbatim (sections A Linear, B Slack app with the manifest, C Tailscale serve and pairing), then append:

```markdown
## Troubleshooting

| Symptom | Fix |
|---|---|
| Settings → Connectors shows `error` for Slack | The token was revoked or a scope is missing. Re-install the Slack app and paste the new User OAuth Token. |
| Slack rejects the redirect URL | Slack requires HTTPS. Use `https://<machine>.<tailnet>.ts.net/api/connectors/slack/callback`, or skip OAuth and paste the User OAuth Token. |
| The phone shows "remote access is disabled" | `remote.enabled`, `remote.origin` and `remote.allowedLogin` must all be set (Settings → Remote). |
| The phone shows "unexpected host" | The origin in Settings must match the MagicDNS name exactly, including `https://` and no trailing slash. |
| The phone shows "Tailscale Funnel is on" | Run `tailscale funnel --https=443 off`. The app refuses remote access while a Funnel exists. |
| Pairing says "wrong or expired pairing code" | Codes last 5 minutes, work once, and are cancelled after five wrong tries. Create a new one. |
| iOS shows no notifications | Add the app to the Home Screen and open it from there first (iOS 16.4+ only allows push for installed web apps). |
| Sending from the phone asks for the passkey every time | That is the step-up. It lasts 5 minutes (`remote.stepUpTtlSec`). |
| A Slack thread reply does nothing | The session must be **owned** (launched or resumed inside the app). The thread's first message says when replies are off. |
| Everything is broken after a Mac restart | `tailscale serve --bg http://127.0.0.1:4317` must run again if you did not use `--bg`, and the daemon must be running. |

## What the app never does
- It never exposes itself to the public internet (no `tailscale funnel`).
- It never sends the install token to a remote device; remote devices use their own revocable token.
- It never posts unredacted text to Slack or Linear.
- It never sends input to a session it does not own.
```

- [ ] **Step 2: Run the full automated gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @orc/web build && pnpm --filter @orc/daemon build
```
Expected: all green. Record the test count in the evidence file.

Run the Phase 6 suites once more on their own, to have a clean list for the evidence file:
```bash
pnpm vitest run packages/api-contract/src/p6-contract.test.ts apps/daemon/src/db/repos/p6-repos.test.ts apps/daemon/test/p6-fakes.test.ts \
  apps/daemon/src/services/secrets apps/daemon/src/connectors apps/daemon/src/remote apps/daemon/src/notify \
  apps/daemon/src/http apps/daemon/src/services/remote apps/daemon/src/services/share apps/daemon/test/p6-daemon.test.ts \
  apps/web/src/pwa apps/web/src/api apps/web/src/features/settings apps/web/src/features/share apps/web/src/features/remote apps/web/src/features/mobile
```

- [ ] **Step 3: Do the manual evidence runs**

Create `plan/phase-6-evidence.md` and fill in every row as you go. Each row needs pasted output or a screenshot path.

```markdown
# Phase 6 — evidence (M6)

Date: <date> · daemon <git sha> · Claude Code <version> · tailscale <version> · phone <iOS/Android version>

## M6-1 Connectors connect as me
| step | evidence |
|---|---|
| Linear personal API key pasted in Settings → Connectors | screenshot: shows "Connected as <name> <email> (api_key)" |
| Slack User OAuth Token pasted (or OAuth flow completed) | screenshot: "Connected as <me> @ <workspace> (user_token)" |
| No token in SQLite | `strings ~/.orchestrator/index.db ~/.orchestrator/index.db-wal \| grep -c -e 'xoxp-' -e 'lin_api_'` → `0` |
| Tokens in the Keychain | `security find-generic-password -s orchestrator -a slack.token -w \| head -c 5` → `xoxp-` |
| Audit | `/audit` filtered by `connector.connect` shows two `ok` entries with no token in params |

## M6-2 Linear comment from a session (F11)
| step | evidence |
|---|---|
| Session detail → "Recap → Linear" → Preview | screenshot of the preview dialog (redacted text) |
| Confirm and post | the comment appears on the Linear issue, authored by **me** |
| Audit | `linear.comment` entry with `target` = the identifier and a 300-char preview |
| Follow-up ticket from the same session | new issue assigned to me, with a "Follow-up from Orchestrator session" footer |

## M6-3 Daily update posted from the app (exit criterion)
| step | evidence |
|---|---|
| Inbox → "Post daily update" → Preview → Confirm | screenshot of the Slack message in the channel, posted as me |
| Audit | `slack.post` entry with `target` = the channel id |

## M6-4 Answer a waiting owned session from the phone (exit criterion)
| step | evidence |
|---|---|
| `tailscale serve --bg http://127.0.0.1:4317` | `tailscale serve status` output |
| Settings → Remote → save origin + login, create pairing code | screenshot of the code |
| Phone opens `https://<machine>.<tailnet>.ts.net/pair`, pairs, creates a passkey, allows notifications | screenshot of "This device is ready" |
| Home-screen install (iOS) | screenshot of the installed icon |
| Start a session in the app, let it ask a question | Live Board shows `waiting` |
| Push notification arrives on the phone | screenshot of the lock screen |
| Tapping it opens the session on the phone | screenshot |
| Type a reply, Send → Face ID / Touch ID prompt → sent | screenshot of the step-up prompt |
| The answer appears in the desktop terminal and the session continues | screenshot of the terminal |
| Audit | `pty.input` entry with `actor: remote`, `actorDetail: "<device> (<login>)"` |

## M6-5 Answer from the Slack DM thread (exit criterion)
| step | evidence |
|---|---|
| Settings → Remote → "Away now" | `away.set` audit entry |
| A waiting item arrives as a DM to myself | screenshot of the Slack thread (redacted text, "Open in Orchestrator" link) |
| Reply "yes, continue" in the thread | the session receives it within 15 s; thread shows ":arrow_right: Sent to the session." |
| React ✅ on a plan-approval item | the plan is approved and the thread shows ":heavy_check_mark: Resolved (done)." |
| Reply `!snooze 30` on another item | the inbox item is snoozed |
| Audit | `pty.input` (`actor: remote`, `actorDetail: slack_dm`) and `remote.approve` entries |

## M6-6 Security checks
| check | expected | evidence |
|---|---|---|
| `/bootstrap.js` from the phone | `window.__ORC_TOKEN__ = null;` | view-source screenshot |
| Install token used from the phone | `401 unauthorized` | `curl` output from a second tailnet device |
| State-changing call without step-up | `401 step_up_required` | `curl` output |
| `POST /api/sessions/launch` from the phone | `403 remote_forbidden` | `curl` output |
| `tailscale funnel --https=443 on` → any remote request | `403 funnel_detected` (then turn the Funnel off again) | `curl` output |
| Deny-listed Slack reply (`terraform apply`) | thread answers `:x: Not done (denied)`, nothing sent | screenshot + `denied` audit entry |
| Reply to an **observed** session | `403 not_owned` | screenshot |
| Revoke the device in Settings → Remote | the phone gets `401` on its next request | screenshot |
| Wrong Tailscale identity (second tailnet user, if available) | `403 remote_identity_mismatch` | `curl` output or "not available" |

## Exit criteria (docs/05-roadmap.md, M6)
- [ ] A waiting session is answered from my phone (PWA) — M6-4
- [ ] A waiting session is answered from the Slack DM thread — M6-5
- [ ] The daily update is posted from the app — M6-3
```

Useful commands while doing the runs:
```bash
# follow what the daemon records
tail -f ~/.orchestrator/logs/daemon.log
# audit entries for this phase
curl -s -H "x-orc-token: $(cat ~/.orchestrator/token)" \
  'http://127.0.0.1:4317/api/audit?limit=50' | python3 -m json.tool | grep -A3 '"action"'
```

- [ ] **Step 4: Merge the Contract additions into `plan/00-contracts.md`**

Apply the "Contract additions" section of this plan to `plan/00-contracts.md`:
1. **§1** — add `@types/web-push` (daemon dev) and `@simplewebauthn/browser`, `workbox-precaching`, `workbox-build`, `workbox-window` (web).
2. **§3** — add `RemoteConfig`, `AwayConfig`, `ConnectorsConfig` and the three `OrcConfig` fields; the `$ORC_HOME` tree entry for `vapid.json` already exists, so add "(created on first boot, mode 0600)".
3. **§4** — append the new audit action names: `connector.connect`, `connector.configure`, `connector.disconnect`, `linear.issue.create`, `inbox.approve`, `remote.configure`, `remote.pairing_code`, `remote.pair`, `remote.revoke`, `webauthn.register`, `away.set`.
4. **§5** — replace the Phase 6 table row with the five tables (`connector_tokens_meta`, `remote_devices`, `webauthn_credentials`, `push_subscriptions`, `slack_threads`) and their keys.
5. **§6** — add the Phase 6 route list, the new error codes, the remote-auth rules (classification, device tokens, the step-up list, `PUBLIC_API_PATHS`, `OrcEnv`), and the three `BusEvent` variants.
6. **§11** — add `LinearConnector`, `SlackConnector`, `SecretStore`, `ShareService`, `SessionActions`, `SlackBridge`, `DeviceService`, `StepUpStore`, `AwayService`, `WebAuthnService` and the `DaemonContext` fields `secrets`, `share`, `sessionActions`, `away`; note that `ServiceError.status` now includes `502`, and that `withPtyInputAudit` reads `actorScope`.
7. **§12** — add the `/pair` route, the mobile breakpoint rule, `resolveToken`, `withStepUp`, the new client methods and the query keys.
8. Add a line under §11 for Phase 7: *`linear.issueChanged` and `slack.mention`, and the pollers in `connectors/linear/assigned-poller.ts` and `connectors/slack/mention-poller.ts`, already exist after Phase 6; Phase 7 consumes them instead of creating them.*

Run: `pnpm check:fixtures && pnpm lint`
Expected: green (the contract file is markdown; this only checks that nothing else broke).

- [ ] **Step 5: Check the exit criteria and update the status table**

| Criterion (docs/05-roadmap.md M6) | Evidence |
|---|---|
| Linear connector acts as me: enriches streams, creates follow-ups, posts recaps and handoffs as comments | M6-1, M6-2 + Task 10 stream chip |
| Slack connector acts as me: posts recaps and daily updates, DM bridge | M6-3, M6-5 |
| Remote & Mobile: Tailscale PWA, Web Push, passkey step-up, away mode | M6-4, M6-5, M6-6 |
| A waiting session is answered from the phone (PWA **or** Slack DM thread) | M6-4 **and** M6-5 |
| The daily update is posted from the app | M6-3 |
| Spike S9 recorded a decision | `plan/spikes/S9.md` |
| Every automated check is green | Step 2 output |

In `plan/README.md`, update the Phase 6 row to `☑ done` and add `plan/phase-6-evidence.md` to the "Spike reports" line as *phase evidence*.

- [ ] **Step 6: Commit and merge**

```bash
git add docs/setup-remote-and-connectors.md plan
git commit -m "docs(plan): record phase 6 outcomes, contracts and evidence"
pnpm lint && pnpm typecheck && pnpm test
git checkout main && git merge --no-ff phase/6-linear-slack-remote -m "merge: phase 6 linear, slack and remote access"
```

---

## Self-review (done while writing this plan)

**1. Spec coverage**

| Spec item | Task |
|---|---|
| F11 Linear: ticket title/status/assignee on streams | 10 (enricher), 11 (`LinearIssueChip`) |
| F11 Linear: create follow-up ticket | 9 (service + route), 11 (dialog) |
| F11 Linear: comment recaps, plans and handoffs | 9 (`ShareSource` recap / handoff / plan), 11 |
| F11 Linear: "assigned to me" events for F20 | 10 (`linear.issueChanged`) |
| F11 Slack: post recaps and daily updates | 9, 11 (`DailyUpdateButton`) |
| F11 Slack: mention events for F20 | 10 (`slack.mention`) |
| F11: act as me, tokens in the Keychain | 4, 5, 6, 7 |
| F22 responsive PWA (Inbox, Live, Session summary, read-only diff, reply composer) | 18, 19 |
| F22 access: Tailscale only, token required, passkey for actions | 12, 14 |
| F22 push: Web Push and Slack DM alternative | 15, 16 |
| F22 actions from the phone: answer, approve plan, approve automation output, snooze, stop | 13 (reply, approve), 12 (kill/merge step-up rules), 19 (inbox card) |
| F22 Slack DM bridge: thread per item, replies, ✅/💤 | 16 |
| F22 away mode: manual and auto on idle | 17 |
| F24 audit for every write | 7, 9, 12, 13, 14, 17, 20 (`NON_ACTION_ROUTES`) |
| M6 exit criteria | 22 |
| Spike S9 | 1 |
| Architecture §9 (daemon still binds 127.0.0.1, identity header check) | 12 |
| Architecture §12 connector interface (`status`, `enrich`, actions) | 5, 6, 10 |
| Security: redaction before every post, 0600 files, no secrets in DB | 5, 6, 9, 15, 7 (DB scan test) |

**2. Placeholder scan** — no `TBD`, `TODO`, "similar to Task N" or "add error handling" remains. Every code step carries complete TypeScript, and every command step has a `Run:` and an `Expected:` line.

**3. Type consistency**

- `SecretStore` keys are the same strings everywhere: `linear.token`, `linear.client_id`, `linear.client_secret`, `linear.refresh_token`, `slack.token`, `slack.client_id`, `slack.client_secret`.
- `ConnectorKey` (`db/repos/connectors.ts`) and `ConnectorId` (api-contract) are the same two values; routes parse with `ConnectorId` and pass `ConnectorKey` on.
- `Who` is defined once in `http/p6-util.ts` and reused by `ShareService`, `SessionActions` and the Slack bridge.
- `RemoteInfo` is defined in `http/p6-util.ts`, used by `types.ts`, `remote-guard.ts` and `ws-remote.ts`.
- `PollerHandle` is defined in `assigned-poller.ts` and re-used by the mention poller and the stream enricher.
- `remoteUrl()` (Task 15) is shared by the push channel and the Slack bridge, so both rewrite the notification URL the same way.
- `inboxSessionPk()` (Task 13) is the only place that maps an inbox item to a session pk; the bridge uses it too.
- `KIND_TITLE` (P2) is used by both notification channels, so titles match across macOS, push and Slack.
- The step-up route list in `REMOTE_RULES` matches the routes actually registered: `/api/sessions/:s/:id/reply` (Task 13), `/api/sessions/:s/:id/kill` (P2), `/api/sessions/:s/:id/plan/(approve|reject)` (P4), `/api/inbox/:id/approve` (Task 13), `/api/pty/:id` (P1), `/api/ship/merge` (P4).
- Client method names in `p6Methods` match the web call sites in Tasks 8, 11, 18 and 19.

**4. Fixes applied while reviewing**

- The confirm flow re-sends the previewed text as `{ kind: 'text' }`, so an LLM recap can't change between preview and post.
- `remoteGuard(null)` keeps P1's tests (and any daemon built without Phase 6) working, and Task 20 asserts that `createDaemon` always passes real deps.
- The Slack bridge advances `last_seen_ts` **before** running a command, so a crash can't deliver the same reply twice.
- `/bootstrap.js` explicitly refuses remote requests; without that fix `tailscale serve` (which connects from 127.0.0.1) would have handed the install token to any tailnet device.
- Push endpoints are restricted to the four known push services, so a stored subscription can't be used to make the daemon call an arbitrary URL.
