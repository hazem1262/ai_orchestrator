import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OrcDb } from '../db/client.ts';
import {
  getRemoteDevice,
  getRemoteDeviceByTokenHash,
  insertRemoteDevice,
  listRemoteDevices,
  listWebauthnCredentials,
  type RemoteDeviceRow,
  revokeRemoteDevice,
  touchRemoteDevice,
} from '../db/repos/remote.ts';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const TOUCH_INTERVAL_MS = 60_000;

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
      if (row.lastSeenAt === null || t.getTime() - Date.parse(row.lastSeenAt) > TOUCH_INTERVAL_MS) {
        touchRemoteDevice(db, row.id, t.toISOString());
      }
      return row;
    },
    get: (id) => getRemoteDevice(db, id),
    list: () =>
      listRemoteDevices(db).map((d) => ({ ...d, credentials: listWebauthnCredentials(db, d.id).length })),
    revoke: (id) => revokeRemoteDevice(db, id, now().toISOString()),
  };
}
