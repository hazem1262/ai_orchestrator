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
import {
  getSlackThread,
  insertSlackThread,
  listOpenSlackThreads,
  updateSlackThread,
} from './slack-threads.ts';

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
      connector: 'slack',
      authKind: 'user_token',
      accountId: 'U1',
      accountLabel: 'me @ acme',
      scopes: ['chat:write'],
      connectedAt: T,
    });
    expect(m).toMatchObject({ connector: 'slack', cursor: {}, lastStatus: 'ok', lastCheckedAt: null });
    setConnectorCursor(db, 'slack', { mentionsSinceTs: '1.000001' });
    setConnectorStatus(db, 'slack', 'error', T);
    expect(getConnectorMeta(db, 'slack')).toMatchObject({
      cursor: { mentionsSinceTs: '1.000001' },
      lastStatus: 'error',
      lastCheckedAt: T,
    });
    upsertConnectorMeta(db, {
      connector: 'slack',
      authKind: 'oauth',
      accountId: 'U1',
      accountLabel: null,
      scopes: [],
      connectedAt: T,
    });
    expect(getConnectorMeta(db, 'slack')).toMatchObject({ authKind: 'oauth', cursor: {}, lastStatus: 'ok' });
    deleteConnectorMeta(db, 'slack');
    expect(getConnectorMeta(db, 'slack')).toBeNull();
  });
});

describe('remote devices, credentials and push subscriptions', () => {
  it('stores hashed devices and revokes them with their credentials and subscriptions', () => {
    insertRemoteDevice(db, {
      id: 'd1',
      name: 'Phone',
      tokenHash: 'h1',
      login: 'me@example.com',
      createdAt: T,
      lastSeenAt: null,
      revokedAt: null,
    });
    insertWebauthnCredential(db, {
      id: 'c1',
      deviceId: 'd1',
      publicKey: 'AQID',
      counter: 0,
      transports: ['internal'],
      createdAt: T,
      lastUsedAt: null,
    });
    upsertPushSubscription(db, {
      deviceId: 'd1',
      endpoint: 'https://fcm.googleapis.com/x',
      p256dh: 'p',
      auth: 'a',
      createdAt: T,
    });
    expect(getRemoteDeviceByTokenHash(db, 'h1')?.id).toBe('d1');
    updateWebauthnCounter(db, 'c1', 5, T);
    expect(getWebauthnCredential(db, 'c1')).toMatchObject({
      counter: 5,
      lastUsedAt: T,
      transports: ['internal'],
    });
    expect(revokeRemoteDevice(db, 'd1', T)).toBe(true);
    expect(listRemoteDevices(db)[0]?.revokedAt).toBe(T);
    expect(listWebauthnCredentials(db, 'd1')).toEqual([]);
    expect(listPushSubscriptions(db)).toEqual([]);
    expect(revokeRemoteDevice(db, 'missing', T)).toBe(false);
  });

  it('upserts push subscriptions by endpoint and counts failures', () => {
    const a = upsertPushSubscription(db, {
      deviceId: null,
      endpoint: 'https://e/1',
      p256dh: 'p1',
      auth: 'a1',
      createdAt: T,
    });
    const b = upsertPushSubscription(db, {
      deviceId: null,
      endpoint: 'https://e/1',
      p256dh: 'p2',
      auth: 'a2',
      createdAt: T,
    });
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
      inboxItemId: 'i1',
      sessionPk: 'claude:s1',
      channel: 'D1',
      rootTs: '10.000100',
      lastSeenTs: '10.000100',
      appTs: ['10.000100'],
      reactionsDone: [],
      state: 'open',
      createdAt: T,
      updatedAt: T,
    });
    expect(listOpenSlackThreads(db).map((t) => t.inboxItemId)).toEqual(['i1']);
    updateSlackThread(
      db,
      'i1',
      { lastSeenTs: '11.000000', appTs: ['10.000100', '11.000000'], reactionsDone: ['zzz'] },
      T,
    );
    expect(getSlackThread(db, 'i1')).toMatchObject({
      lastSeenTs: '11.000000',
      reactionsDone: ['zzz'],
      appTs: ['10.000100', '11.000000'],
    });
    updateSlackThread(db, 'i1', { state: 'resolved' }, T);
    expect(listOpenSlackThreads(db)).toEqual([]);
  });
});
