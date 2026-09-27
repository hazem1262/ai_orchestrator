import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActor } from '@orc/core';

/** Run code inside `actorScope.run({ actor, actorDetail }, fn)` so audited wrappers attribute it correctly. */
export const actorScope = new AsyncLocalStorage<{ actor: AuditActor; actorDetail: string | null }>();
