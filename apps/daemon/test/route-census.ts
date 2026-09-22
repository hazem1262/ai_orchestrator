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
 * Task 16's `registerPhase2Routes` will have to add its file — which is the same moment it has to
 * add its routes to `CENSUS`.
 */
export const REGISTRAR_FILES = [
  'apps/daemon/src/http/app.ts',
  'apps/daemon/src/http/routes/health.ts',
  'apps/daemon/src/http/routes/hooks.ts',
  // Registers `/api/inbox` routes but is not yet wired into `registerAllRoutes`; Task 16 wires it
  // and adds its routes to `CENSUS`.
  'apps/daemon/src/http/routes/inbox.ts',
  'apps/daemon/src/http/routes/live.ts',
  // Registers `/api/config/notifications` but is not yet wired into `registerAllRoutes`; Task 16
  // wires it and adds its routes to `CENSUS`.
  'apps/daemon/src/http/routes/notifications.ts',
  'apps/daemon/src/http/routes/projects.ts',
  'apps/daemon/src/http/routes/pty.ts',
  'apps/daemon/src/http/routes/sessions.ts',
  // Registers `/api/templates` but is not yet wired into `registerAllRoutes`; Task 16 wires it
  // and adds its routes to `CENSUS`.
  'apps/daemon/src/http/routes/templates.ts',
  'apps/daemon/src/http/routes/views.ts',
  'apps/daemon/src/http/static.ts',
];

/**
 * Every file allowed to call `apiError` directly rather than through `redactedApiError`. Each is
 * allowed only because its message and details are compile-time constants.
 */
export const RAW_API_ERROR_FILES: Record<string, string> = {
  'apps/daemon/src/http/app.ts':
    'the host/origin/token middleware, the 404 catch-all and the 500 — all constant strings',
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
 * The only route `createApp` registers outside `registerAllRoutes`. (`ALL /api/*` appears on both
 * sides and dedupes to one key: the auth middleware in `createApp`, the 404 catch-all in
 * `registerAllRoutes`.) Anything else that shows up in `createApp` but not in `registerAllRoutes`
 * has been routed around the single registration path, and fails the test below.
 */
export const CREATE_APP_LOCAL = ['GET /bootstrap.js', 'GET /*'];
