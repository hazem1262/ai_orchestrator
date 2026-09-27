import type { AuditActor } from '@orc/core';
import type { Context } from 'hono';
import { ServiceError } from '../services/errors.ts';
import type { OrcEnv } from './types.ts';

// Every helper here throws `ServiceError`; `createApp`'s `onError` answers it through `redactedApiError`.

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
  if (!r || r.deviceId === null)
    throw new ServiceError('remote_only', 403, 'open this page on a paired device');
  return { ...r, deviceId: r.deviceId };
}

export function confirmOr409(
  confirm: boolean | undefined,
  summary: string,
  extra: Record<string, unknown> = {},
): void {
  if (confirm !== true) {
    throw new ServiceError('confirmation_required', 409, 'confirm to continue', { summary, ...extra });
  }
}

/** A Phase 6 service that is optional on `DaemonContext`; unwired answers `503 unavailable` (contracts §6, P4 errors). */
export function need<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new ServiceError('unavailable', 503, `${name} is not wired`);
  return v;
}
