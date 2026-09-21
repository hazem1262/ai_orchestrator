import type { RegistryStatus } from '../claude/registry.ts';
import type { LiveStatus, Source } from '../types/index.ts';
import type { TranscriptLive } from './live-transcript.ts';

export interface DeriveStatusInput {
  alive: boolean;
  registryStatus: RegistryStatus | null;
  transcript: TranscriptLive;
}

/**
 * Precedence: `ended` (process is dead) > `waiting`/`busy`/`shell` (straight from the registry,
 * which is the product's headline signal — see Spike S3) > `error` (the transcript's last
 * assistant record was an API error) > `review` (the turn ended having changed a file or opened
 * a PR) > `idle`.
 *
 * A registry `idle` never overrides transcript evidence of an error or a reviewable turn end:
 * the registry only tells us the CLI's own idea of prompt-loop state, and per Spike S3 its
 * `statusUpdatedAt` is the AGE of the last status change at first scan, not a detection delay, so
 * it is treated as a coarse status label, not a timestamp of truth. When the registry is absent
 * (`null`, e.g. a `kind` the daemon doesn't track a registry for), transcript evidence still
 * drives `error`/`review`, falling back to `idle`.
 *
 * `blocked` needs goals data that doesn't exist until Phase 5, so it never comes out of this
 * function yet — Task 5-8 consumers should not expect it.
 */
export function deriveLiveStatus(i: DeriveStatusInput): LiveStatus {
  if (!i.alive) return 'ended';
  if (i.registryStatus === 'waiting' || i.registryStatus === 'busy' || i.registryStatus === 'shell') {
    return i.registryStatus;
  }
  if (i.transcript.lastApiError) return 'error';
  if (i.transcript.turnEnded && (i.transcript.turnChangedFiles.length > 0 || i.transcript.turnPrs > 0)) {
    return 'review';
  }
  return 'idle';
}

const SOURCES = new Set<string>(['claude', 'codex', 'agnc']);

/**
 * Splits a session primary key (`<source>:<id>`) on the *first* colon only, since Codex/AGNC ids
 * can themselves contain colons. Throws for an unrecognised source or a missing id.
 */
export function splitPk(pk: string): { source: Source; id: string } {
  const at = pk.indexOf(':');
  const source = at > 0 ? pk.slice(0, at) : '';
  const id = at > 0 ? pk.slice(at + 1) : '';
  if (!SOURCES.has(source) || !id) throw new Error(`invalid session pk: ${pk}`);
  return { source: source as Source, id };
}
