/**
 * The route census: the shared, single declaration of every route the daemon serves and what
 * guards its response. Lives outside both test files because two of them consume it —
 * `src/http/redact-out.test.ts` checks it against the routes the app really registers, and
 * `src/http/app.test.ts` derives a live sentinel probe from every guarded row. A row that names a
 * redactor its handler never calls fails the probe; a row with no probe fails the coverage check.
 */
// ---------------------------------------------------------------------------------------------
// The meta-gap: the guard above is exhaustive WITHIN a shape, but `CASES` is a hand-written list.
// Nothing above notices a sixth shape that crosses the boundary with no redactor at all — which
// is how `Project.pathPrefixes`, `PtyInfo.args` and `SavedView.query` were served raw for a whole
// phase. "Someone must remember", moved up one level, is still the failure mode that cost us
// thirteen fields. These three tests chain route -> redactor -> case so it cannot recur:
//
//   1. the routes the daemon actually registers must all be declared here (a new route fails);
//   2. every redactor a declaration names must really be exported by `redact-out.ts`;
//   3. every SHAPE redactor `redact-out.ts` exports must appear in `CASES` (a new shape fails).
//
// The census can only see SUCCESS bodies. Error bodies are a second response channel, and one of
// them (`cwd_missing`) was serving `startCwd` raw on a route this table calls guarded. That is
// handled where it belongs — `app.ts`'s `onError` walks every `ServiceError` message and details
// through `redactValue` — rather than by enumerating each route's possible errors here.
// `app.test.ts > route-level redaction` is the third link: it hits the real routes, success and
// error alike, with sentinels seeded into every shape below.
// ---------------------------------------------------------------------------------------------

export interface CensusEntry {
  /** The `redact-out.ts` export that guards this response, or null when there is no free text. */
  guardedBy: string | null;
  reason: string;
}

export const CENSUS: Record<string, CensusEntry> = {
  'ALL /*': {
    guardedBy: null,
    reason:
      'the remote guard middleware: classifies local vs remote and answers remote rejections with constant apiError bodies',
  },
  'ALL /api/*': { guardedBy: null, reason: 'the auth middleware and the 404 catch-all; apiError only' },
  'GET /api/health': { guardedBy: null, reason: 'version, uptime and counts' },
  'GET /bootstrap.js': {
    guardedBy: null,
    reason: 'deliberately serves the loopback token itself to a same-origin local request',
  },
  'GET /api/sessions': { guardedBy: 'redactListItem', reason: '' },
  'GET /api/sessions/:source/:id': { guardedBy: 'redactSession', reason: '' },
  'GET /api/sessions/:source/:id/events': { guardedBy: 'redactEvent', reason: '' },
  'GET /api/sessions/:source/:id/agents': { guardedBy: 'redactAgent', reason: '' },
  'POST /api/sessions/:source/:id/resume': { guardedBy: 'redactResume', reason: '' },
  'POST /api/sessions/:source/:id/pin': { guardedBy: null, reason: '{ pinned: boolean }' },
  'POST /api/sessions/:source/:id/label': { guardedBy: 'redactLabels', reason: '' },
  'GET /api/labels': { guardedBy: 'redactLabels', reason: '' },
  'GET /api/projects': { guardedBy: 'redactProject', reason: '' },
  'GET /api/projects/:id': {
    guardedBy: null,
    reason:
      'the settings editor round-trip: the client GETs this, edits a field and PATCHes the whole ' +
      'object back, so a tag written here would land in the user’s own config.json as the new ' +
      'pathPrefixes and unbind the project. User-authored config, not transcript-derived.',
  },
  'PATCH /api/projects/:id': { guardedBy: null, reason: 'echoes the config the client just sent; see above' },
  'GET /api/pty': { guardedBy: 'redactPtyInfo', reason: '' },
  'DELETE /api/pty/:ptyId': {
    guardedBy: 'redactPtyInfo',
    reason: 'the 409 confirmation summary embeds the same argv and cwd, built from the redacted view',
  },
  'GET /api/views': { guardedBy: 'redactSavedView', reason: '' },
  'POST /api/views': { guardedBy: 'redactSavedView', reason: '' },
  'DELETE /api/views/:id': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/live': { guardedBy: 'redactSession', reason: '' },
  'POST /api/hooks': {
    guardedBy: null,
    reason: '{ ok: true }; the hook body is reduced to three fields and never echoed back',
  },
  'GET /api/hooks/install': {
    guardedBy: null,
    reason: 'local paths, the hook command and the settings snippet; no transcript data',
  },
  'POST /api/hooks/install': {
    guardedBy: null,
    reason: 'the settings and backup paths; the 409 summary carries the same status fields',
  },
  'GET /api/hooks/statusline': {
    guardedBy: null,
    reason: 'the statusline command and its settings snippet; no user or transcript data',
  },
  'GET /api/inbox': { guardedBy: 'redactInboxItem', reason: '' },
  'POST /api/inbox/:id/:action{done|snooze|reopen}': { guardedBy: 'redactInboxItem', reason: '' },
  'GET /api/templates': {
    guardedBy: null,
    reason: 'the built-in templates: compile-time constants, no user or transcript data',
  },
  'POST /api/sessions/launch': {
    guardedBy: null,
    reason: '{ ptyId, sessionId }: the daemon-minted pty id and the discovered session id',
  },
  'POST /api/sessions/:source/:id/kill': { guardedBy: null, reason: '{ killed: "pty" | "pid" }' },
  'POST /api/sessions/:source/:id/open-in': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/config/notifications': {
    guardedBy: null,
    reason: 'per-kind enabled flags and channel names from the user’s own config',
  },
  'PUT /api/config/notifications': {
    guardedBy: null,
    reason: 'echoes the preferences the client just sent, after schema validation',
  },
  'GET /api/archive/status': {
    guardedBy: null,
    reason: 'counts, bytes, the codec, a daemon-derived ISO timestamp and a constant snippet',
  },
  'GET /api/audit': {
    guardedBy: null,
    reason:
      'audit entries are redacted when recorded (AuditService) and again with redactDeep on the way out',
  },
  'GET /api/safety/secrets': {
    guardedBy: null,
    reason:
      'file paths from the user’s own config plus { line, kind } per finding; the scanner never returns matched values',
  },
  'POST /api/safety/deny-check': {
    guardedBy: null,
    reason:
      '{ denied, reason }; the reason quotes the match only after core redact() and truncation to 80 chars',
  },
  'GET /api/sessions/:source/:id/stats': {
    guardedBy: null,
    reason:
      'timing and token counts per turn and agent; the body still passes through redactedJson (core redactDeep)',
  },
  'GET /api/sessions/:source/:id/deliverables': {
    guardedBy: null,
    reason:
      'transcript-derived file paths and tool names, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/sessions/:source/:id/files': {
    guardedBy: null,
    reason:
      'transcript-derived paths and edit snippets, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/sessions/:source/:id/usage-series': {
    guardedBy: null,
    reason:
      'token counts, model names and apportioned cost, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/sessions/:source/:id/safety': {
    guardedBy: null,
    reason:
      'permission mode and prod-touch details from tool inputs, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/sessions/:source/:id/raw': {
    guardedBy: null,
    reason:
      'raw transcript lines: each line is redact()ed in readJsonlPage and the page again by redactedJson (core redactDeep)',
  },
  'GET /api/sessions/:source/:id/links': {
    guardedBy: null,
    reason:
      'PR refs, ticket ids, plan titles/paths and transcript artifact links, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/sessions/:source/:id/export': {
    guardedBy: null,
    reason:
      'a ZIP, not JSON: redacted by default (core redact() per transcript line, redactDeep on every JSON file); ' +
      'redact=false needs confirm=true and is audited as session.export',
  },
  'GET /api/plans': {
    guardedBy: null,
    reason:
      'plan paths and redact()ed titles from the read-only plan roots, walked by redactedJson (core redactDeep)',
  },
  'GET /api/plans/content': {
    guardedBy: null,
    reason:
      'plan markdown from the allowed roots only, capped at 512 KB, redact()ed on read and again by redactedJson (core redactDeep)',
  },
  'POST /api/archive/sync': { guardedBy: null, reason: '{ copied: number }' },
  'POST /api/archive/restore': {
    guardedBy: 'redactValue',
    reason: 'the restored paths, and the 409 summary and target list, are transcript paths',
  },
  // Phase 4 sub-apps (routes/worktrees, github, review, ship, plan). Their error bodies go through
  // `phase4App`'s onError, which renders every one with `redactedApiError`.
  'GET /api/worktrees': {
    guardedBy: null,
    reason:
      'worktree views: paths discovered from session cwds, branches and session pks, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/worktrees/one': {
    guardedBy: null,
    reason: 'one worktree view, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/worktrees/discover': {
    guardedBy: null,
    reason: 'the refreshed worktree views, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/worktrees': {
    guardedBy: null,
    reason:
      'the new worktree view plus daemon-minted pty/session ids, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/worktrees/script': { guardedBy: null, reason: '{ ptyId }: the daemon-minted pty id' },
  'POST /api/worktrees/open': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/worktrees/sync-preview': {
    guardedBy: null,
    reason:
      'worktree and main paths plus git-listed file names, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/worktrees/sync': { guardedBy: null, reason: '{ files: number }' },
  'POST /api/worktrees/archive': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/github/status': { guardedBy: null, reason: '{ status }: one of four constants' },
  'GET /api/github/pr': {
    guardedBy: null,
    reason: 'PR state, checks and review from gh for the PR the client named; no transcript data',
  },
  'GET /api/github/prs/mine': {
    guardedBy: null,
    reason: "the user's own open PRs from gh; no transcript data",
  },
  'GET /api/diff': {
    guardedBy: null,
    reason: 'git diff of a worktree (file contents), walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/diff/revert': {
    guardedBy: null,
    reason: '{ reverted: path }, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/checkpoints': {
    guardedBy: null,
    reason:
      'checkpoint records (session id, worktree path, refs), walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/checkpoints/:id/diff': {
    guardedBy: null,
    reason:
      'git diff between checkpoint snapshots (file contents), walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/checkpoints': {
    guardedBy: null,
    reason: 'the new checkpoint record, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/checkpoints/:id/rewind': {
    guardedBy: null,
    reason: 'the safety checkpoint record, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/review/:source/:id': {
    guardedBy: null,
    reason:
      'review summary: session cwd, recap, diff stats, last test, PR, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/review/:source/:id/comments': {
    guardedBy: null,
    reason:
      '{ sent, text }: the review prompt built from the comments, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/ship/suggest': {
    guardedBy: null,
    reason:
      'commit message, PR title and body built from the session recap and ticket, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/ship/commit': { guardedBy: null, reason: '{ sha }: the new commit id' },
  'POST /api/ship/push': { guardedBy: null, reason: '{ ok: true }' },
  'POST /api/ship/pr': { guardedBy: null, reason: '{ repo, number, url } of the PR gh just created' },
  'POST /api/ship/merge': { guardedBy: null, reason: '{ ok: true }' },
  'POST /api/ship/backmerge': {
    guardedBy: null,
    reason: '{ ptyId }: the daemon-minted pty id of the launched workflow',
  },
  'POST /api/sessions/:source/:id/plan/approve': { guardedBy: null, reason: '{ ok: true }' },
  'POST /api/sessions/:source/:id/plan/reject': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/usage': {
    guardedBy: null,
    reason: 'the quota snapshot: token counts, costs, fractions and daemon-derived ISO timestamps',
  },
  'GET /api/usage/budgets': {
    guardedBy: null,
    reason: 'budget rows (user-set scope ids and limits) with computed spend and period start',
  },
  'PUT /api/usage/budgets': { guardedBy: null, reason: 'echoes the budget row the client just sent' },
  'DELETE /api/usage/budgets/:id': { guardedBy: null, reason: '{ ok: true }' },
  'GET /api/usage/concurrency': {
    guardedBy: null,
    reason: '{ projectId, owned, max } per configured project',
  },
  'GET /api/usage/context/:source/:id': {
    guardedBy: null,
    reason:
      'session pk, transcript model name and token counts, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/usage/official': { guardedBy: null, reason: '204 with no body' },
  'GET /api/settings': {
    guardedBy: null,
    reason: 'the recaps, limits, digest and hooks sections of the user’s own config',
  },
  'PUT /api/settings': {
    guardedBy: null,
    reason: 'echoes the config sections after schema validation',
  },
  'GET /api/streams': {
    guardedBy: null,
    reason:
      'stream rows whose titles come from PR titles and session names, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/streams/refresh': {
    guardedBy: null,
    reason: 'the recomputed stream rows, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/streams/:ticket': {
    guardedBy: null,
    reason:
      'stream detail with session prompts and recaps in the timeline, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/streams/:ticket/link': {
    guardedBy: null,
    reason: 'echoes the manual link row (ticket, kind, ref) the client just sent',
  },
  'POST /api/streams/:ticket/unlink': {
    guardedBy: null,
    reason: 'echoes the manual exclusion row (ticket, kind, ref) the client just sent',
  },
  'GET /api/analytics/cost': {
    guardedBy: null,
    reason:
      'cost rows keyed by day, project, model, source or transcript-derived ticket, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/analytics/top': {
    guardedBy: null,
    reason:
      'top sessions (session names, tickets) and tickets by cost, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/analytics/tools': {
    guardedBy: null,
    reason:
      'tool, MCP server and skill names from transcripts with counts, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/analytics/timing': {
    guardedBy: null,
    reason: 'model and tool milliseconds and per-bucket cache hit rates; numbers and dates only',
  },
  'GET /api/analytics/outcomes': {
    guardedBy: null,
    reason:
      'outcome, friction and goal-category counts from Claude facets, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/analytics/wstack': {
    guardedBy: null,
    reason:
      'wstack skill names, outcome counts and durations, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/analytics/digest': {
    guardedBy: null,
    reason:
      'the latest digest markdown (PR titles, session names), walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/analytics/digest': {
    guardedBy: null,
    reason:
      'the generated digest markdown (PR titles, session names), walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/recaps/session/:source/:id': {
    guardedBy: null,
    reason:
      'the latest session recap (model output over a transcript digest), walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/recaps/session/:source/:id': {
    guardedBy: null,
    reason: 'the generated session recap text, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/recaps/daily': {
    guardedBy: null,
    reason:
      'the latest daily project recap (session names, tickets, recaps), walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/recaps/daily': {
    guardedBy: null,
    reason: 'the generated daily project recap text, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/recaps/spend': {
    guardedBy: null,
    reason: "this month's recap spend and budget; numbers only",
  },
  'GET /api/goals': {
    guardedBy: null,
    reason:
      'goal objectives (prefilled from session prompts and stream titles), walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/goals/:targetType/:targetId': {
    guardedBy: null,
    reason:
      'the goal and its prefill from the session first prompt or stream title, walked by redactedJson (core redactDeep) on the way out',
  },
  'PUT /api/goals/:targetType/:targetId': {
    guardedBy: null,
    reason: 'the saved goal, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/handoffs/session/:source/:id': {
    guardedBy: null,
    reason:
      'the generated handoff (model output over a redacted digest), walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/handoffs/session/:source/:id': {
    guardedBy: null,
    reason: 'the latest handoff and its markdown, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/handoffs/:id/markdown': {
    guardedBy: null,
    reason: 'the handoff markdown download, passed through core redact before it is sent',
  },
  'POST /api/handoffs/:id/resume-fresh': {
    guardedBy: null,
    reason:
      'launches a session through the P2 launcher (argv rules, concurrency cap); needs {"confirm": true}; the confirmation summary goes through redactedApiError',
  },
  'GET /api/reminders': {
    guardedBy: null,
    reason: 'reminder rows with user-typed text, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/reminders': {
    guardedBy: null,
    reason: 'the created reminder, walked by redactedJson (core redactDeep) on the way out',
  },
  'POST /api/reminders/:id/cancel': {
    guardedBy: null,
    reason: 'the cancelled reminder, walked by redactedJson (core redactDeep) on the way out',
  },
  'GET /api/connectors': {
    guardedBy: null,
    reason: 'connector status rows: ids, health, auth kind and the account label; never a token',
  },
  'POST /api/connectors/:id/token': {
    guardedBy: null,
    reason: 'the connector status row after the token is verified; the token itself is never echoed',
  },
  'POST /api/connectors/:id/app': {
    guardedBy: null,
    reason: '{ ok: true }; the client secret is never echoed',
  },
  'GET /api/connectors/:id/authorize': {
    guardedBy: null,
    reason: 'the provider authorize URL (client id, redirect URI, one-time state); no secret',
  },
  'GET /api/connectors/:id/callback': {
    guardedBy: null,
    reason:
      'public HTML page for the OAuth redirect; provider and exchange error text goes through core redact and is HTML-escaped',
  },
  'DELETE /api/connectors/:id': {
    guardedBy: null,
    reason: '{ ok: true }; the 409 confirmation summary is a constant sentence with the connector id',
  },
  'GET /api/linear/issues/:identifier': {
    guardedBy: null,
    reason:
      'the Linear issue (identifier, title, state, assignee, url, labels) from the user workspace; never a token',
  },
  'POST /api/linear/issues/:identifier/comment': {
    guardedBy: null,
    reason:
      '{ ok: true }; the 409 confirmation preview is composed through core redact before it is returned',
  },
  'POST /api/linear/follow-up': {
    guardedBy: null,
    reason: 'the created Linear issue; the 409 preview of title and description goes through core redact',
  },
  'POST /api/slack/post': {
    guardedBy: null,
    reason: '{ ts }; the 409 confirmation preview is composed through core redact before it is returned',
  },
  // Only registered when `webDist` is set, which production always does and the census's first
  // `createApp(...)` call did not — so this route, and anything else added inside
  // `registerStatic`, was invisible here while being live and UNAUTHENTICATED (the auth
  // middleware is scoped to `/api/*`). The census now builds an app for every point in the
  // option space instead of one.
  'GET /*': {
    guardedBy: null,
    reason: 'serves the built web bundle off disk; it returns no daemon data at all',
  },
};

/**
 * Every file allowed to register an HTTP route. A `registerExtra`-style hook cannot be added
 * quietly: its body has to call `app.get(...)` somewhere, and that somewhere must be listed here.
 * A new registrar file is added here at the same moment its routes are added to `CENSUS`.
 */
export const REGISTRAR_FILES = [
  'apps/daemon/src/http/app.ts',
  'apps/daemon/src/http/routes/analytics.ts',
  'apps/daemon/src/http/routes/archive.ts',
  'apps/daemon/src/http/routes/audit.ts',
  'apps/daemon/src/http/routes/connectors.ts',
  'apps/daemon/src/http/routes/export.ts',
  'apps/daemon/src/http/routes/github.ts',
  'apps/daemon/src/http/routes/goals.ts',
  'apps/daemon/src/http/routes/handoffs.ts',
  'apps/daemon/src/http/routes/health.ts',
  'apps/daemon/src/http/routes/hooks.ts',
  'apps/daemon/src/http/routes/inbox.ts',
  'apps/daemon/src/http/routes/launch.ts',
  'apps/daemon/src/http/routes/links.ts',
  'apps/daemon/src/http/routes/live.ts',
  'apps/daemon/src/http/routes/notifications.ts',
  'apps/daemon/src/http/routes/plan.ts',
  'apps/daemon/src/http/routes/projects.ts',
  'apps/daemon/src/http/routes/pty.ts',
  'apps/daemon/src/http/routes/push.ts',
  'apps/daemon/src/http/routes/recaps.ts',
  'apps/daemon/src/http/routes/remote.ts',
  'apps/daemon/src/http/routes/reminders.ts',
  'apps/daemon/src/http/routes/review.ts',
  'apps/daemon/src/http/routes/safety.ts',
  'apps/daemon/src/http/routes/session-actions.ts',
  'apps/daemon/src/http/routes/session-detail.ts',
  'apps/daemon/src/http/routes/sessions.ts',
  'apps/daemon/src/http/routes/settings.ts',
  'apps/daemon/src/http/routes/share.ts',
  'apps/daemon/src/http/routes/ship.ts',
  'apps/daemon/src/http/routes/streams.ts',
  'apps/daemon/src/http/routes/templates.ts',
  'apps/daemon/src/http/routes/usage.ts',
  'apps/daemon/src/http/routes/views.ts',
  'apps/daemon/src/http/routes/webauthn.ts',
  'apps/daemon/src/http/routes/worktrees.ts',
  'apps/daemon/src/http/static.ts',
];

/**
 * Every file allowed to call `apiError` directly rather than through `redactedApiError`. Each is
 * allowed only because its message and details are compile-time constants.
 */
export const RAW_API_ERROR_FILES: Record<string, string> = {
  'apps/daemon/src/http/app.ts': 'the 404 catch-all and the 500 — both constant strings',
  'apps/daemon/src/http/redact-out.ts': 'redactedApiError itself',
  'packages/api-contract/src/errors.ts': 'the definition',
};

/**
 * Every export of `redact-out.ts`, split by what it is. `shape` members must each have a `CASES`
 * entry and are then walked exhaustively. `primitive` members have no schema to walk — a bare
 * `string[]`, a two-branch union, a raw value — so each one has a focused test in this file
 * instead; `every primitive redactor has a focused test` below pins that.
 */
export const EXPORT_KINDS: Record<string, 'shape' | 'primitive' | 'data'> = {
  SECRET_KEY_PATTERNS: 'data',
  redactedApiError: 'primitive',
  redactSession: 'shape',
  redactListItem: 'shape',
  redactEvent: 'shape',
  redactAgent: 'shape',
  redactInboxItem: 'shape',
  redactProject: 'shape',
  redactPtyInfo: 'shape',
  redactSavedView: 'shape',
  redactResume: 'primitive',
  redactLabels: 'primitive',
  redactValue: 'primitive',
  redactSnippet: 'primitive',
};

/**
 * The only routes `createApp` registers outside `registerAllRoutes`: the remote guard, bootstrap
 * and the static bundle. (`ALL /api/*` appears on both
 * sides and dedupes to one key: the auth middleware in `createApp`, the 404 catch-all in
 * `registerAllRoutes`.) Anything else that shows up in `createApp` but not in `registerAllRoutes`
 * has been routed around the single registration path, and fails the test below.
 */
export const CREATE_APP_LOCAL = ['ALL /*', 'GET /bootstrap.js', 'GET /*'];
