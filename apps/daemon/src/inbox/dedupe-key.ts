import type { InboxItem, InboxKind } from '@orc/core';

type ScopeField = 'session' | 'project' | 'ticket' | 'domain' | 'id' | 'global';

/**
 * One variant of `InboxScope`, with every field belonging to a *different* variant explicitly
 * closed off. Without this, TypeScript's excess-property check happily accepts
 * `{ session: 'claude:s', project: 'p1' }` — a union of single-field objects is structurally
 * satisfied by the first member — and the composer would silently drop `project`.
 */
type Exclusive<T extends Partial<Record<ScopeField, unknown>>> = T & {
  [K in Exclude<ScopeField, keyof T>]?: never;
};

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
  | Exclusive<{ session: string }>
  /** A whole project, addressed by its project id. */
  | Exclusive<{ project: string }>
  /** A ticket, across whatever sessions touch it. */
  | Exclusive<{ ticket: string }>
  /**
   * Anything else that has a stable identity of its own: a PR, a worktree, an automation run, a
   * quota window. `domain` names the namespace and `id` addresses the thing inside it — e.g.
   * `{ domain: 'pr', id: 'owner/repo#4' }`, `{ domain: 'worktree', id: '/Users/x/wt' }`. This is
   * the escape hatch that keeps later phases from falling back on `{ global: true }` plus a
   * hand-composed facet, which would reintroduce the very hand-written key this type removes.
   *
   * `session`, `project` and `ticket` are sugar for the domains of the same name, so
   * `{ domain: 'session', id: pk }` composes to the same key as `{ session: pk }`. That is
   * aliasing of one identity, not a collision of two.
   */
  | Exclusive<{ domain: string; id: string }>
  /** Genuinely global: one item for the whole daemon (use `facet` to have more than one). */
  | Exclusive<{ global: true }>;

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
  if (scope.session !== undefined) return ['session', scope.session];
  if (scope.project !== undefined) return ['project', scope.project];
  if (scope.ticket !== undefined) return ['ticket', scope.ticket];
  if (scope.domain !== undefined) return [scope.domain, scope.id];
  return ['global', null];
}

/**
 * The one and only composer of `InboxItem.dedupeKey`. Nothing else in the daemon builds one, and
 * `InboxUpsert` has no field to supply one — that is the promise the redaction boundary's
 * allowlist rests on (`apps/daemon/src/http/redact-out.test.ts`).
 *
 * Shape: `${kind}:${tag}[:${id}][:${facet}]`, where every variable segment is percent-encoded.
 * `kind` is a closed enum and the encoding escapes the `:` separator, so the mapping from
 * `{kind, scope, facet}` to string is injective: no two distinct identities can collide, not even
 * a session pk that itself contains a colon (`claude:s` + facet `x` vs. session `claude:s:x`), nor
 * a domain that contains one (`{domain:'a:b', id:'c'}` vs `{domain:'a', id:'b', facet:'c'}`).
 */
export function inboxDedupeKey(key: InboxKey): InboxItem['dedupeKey'] {
  const [tag, value] = scopeParts(key.scope);
  const head =
    value === null
      ? `${key.kind}:${encodeURIComponent(tag)}`
      : `${key.kind}:${encodeURIComponent(tag)}:${encodeURIComponent(value)}`;
  // `!== undefined`, not truthiness: `facet: ''` must still split the key, or the promise that a
  // facet can only ever split and never merge would be false for exactly one value.
  return key.facet !== undefined ? `${head}:${encodeURIComponent(key.facet)}` : head;
}
