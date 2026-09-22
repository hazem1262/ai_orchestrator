import type { InboxKind } from '@orc/core';

/**
 * What an inbox item is *about*.
 *
 * The dedupe key is the only thing standing between two unrelated sessions and one shared inbox
 * row: the unique index is on the literal key string, so if two callers hand-write the same key,
 * the second session's item is rejected and the user never learns it existed. Silent suppression
 * is the worst failure this component has, so the scope is a *structure*, not a string a caller
 * assembles. There is no shape of `InboxScope` that omits the session, and therefore no way to
 * forget it.
 */
export type InboxScope =
  /** A single session, addressed by its pk (`${source}:${id}`). */
  | { session: string }
  /** A whole project, addressed by its project id. */
  | { project: string }
  /** A ticket, across whatever sessions touch it. */
  | { ticket: string }
  /** Not about any one session, project or ticket (a daily digest, a budget ceiling, …). */
  | { global: true };

/** The identity of an inbox item: what it is (`kind`) and what it is about (`scope`, `facet`). */
export interface InboxKey {
  kind: InboxKind;
  scope: InboxScope;
  /**
   * An extra discriminator for the case where one kind raises several *distinct* items for one
   * scope — a PR's `checks` and its `review`, say. Adding a facet can only ever split one key into
   * two; it can never merge two scopes into one, so it cannot reintroduce the suppression bug.
   */
  facet?: string;
}

type ScopeParts = readonly [tag: string, value: string | null];

function scopeParts(scope: InboxScope): ScopeParts {
  if ('session' in scope) return ['session', scope.session];
  if ('project' in scope) return ['project', scope.project];
  if ('ticket' in scope) return ['ticket', scope.ticket];
  return ['global', null];
}

/**
 * The one and only composer of `InboxItem.dedupeKey`. Nothing else in the daemon builds one, and
 * `InboxUpsert` has no field to supply one — that is the promise the redaction boundary's
 * allowlist rests on (`apps/daemon/src/http/redact-out.test.ts`).
 *
 * `kind` and the scope tag are closed enums, and the variable parts are percent-encoded, which
 * escapes the `:` separator. The mapping from `{kind, scope, facet}` to string is therefore
 * injective: no two distinct identities can collide, not even a session pk that itself contains a
 * colon (`claude:s` + facet `x` vs. session `claude:s:x`).
 */
export function inboxDedupeKey(key: InboxKey): string {
  const [tag, value] = scopeParts(key.scope);
  const head = value === null ? `${key.kind}:${tag}` : `${key.kind}:${tag}:${encodeURIComponent(value)}`;
  return key.facet ? `${head}:${encodeURIComponent(key.facet)}` : head;
}
