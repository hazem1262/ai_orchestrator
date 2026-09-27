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
  return db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.deviceId, deviceId))
    .all()
    .map(toCred);
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
  db.update(pushSubscriptions)
    .set({ lastOkAt: at, failures: 0 })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}

export function markPushFailure(db: OrcDb, endpoint: string): number {
  db.update(pushSubscriptions)
    .set({ failures: sql`${pushSubscriptions.failures} + 1` })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
  return (
    db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get()?.failures ?? 0
  );
}
