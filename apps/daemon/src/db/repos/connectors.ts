import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { connectorTokensMeta } from '../schema-p6.ts';

export type ConnectorKey = 'linear' | 'slack';
export type ConnectorAuthKind = 'api_key' | 'oauth' | 'user_token';
export type ConnectorHealth = 'ok' | 'unauthenticated' | 'error';

export interface ConnectorMeta {
  connector: ConnectorKey;
  authKind: ConnectorAuthKind;
  accountId: string | null;
  accountLabel: string | null;
  scopes: string[];
  cursor: Record<string, unknown>;
  lastStatus: ConnectorHealth;
  connectedAt: string;
  lastCheckedAt: string | null;
}

type Row = typeof connectorTokensMeta.$inferSelect;

function toMeta(r: Row): ConnectorMeta {
  return {
    connector: r.connector as ConnectorKey,
    authKind: r.authKind as ConnectorAuthKind,
    accountId: r.accountId,
    accountLabel: r.accountLabel,
    scopes: JSON.parse(r.scopesJson) as string[],
    cursor: JSON.parse(r.cursorJson) as Record<string, unknown>,
    lastStatus: r.lastStatus as ConnectorHealth,
    connectedAt: r.connectedAt,
    lastCheckedAt: r.lastCheckedAt,
  };
}

export function getConnectorMeta(db: OrcDb, connector: ConnectorKey): ConnectorMeta | null {
  const r = db.select().from(connectorTokensMeta).where(eq(connectorTokensMeta.connector, connector)).get();
  return r ? toMeta(r) : null;
}

export function upsertConnectorMeta(
  db: OrcDb,
  m: {
    connector: ConnectorKey;
    authKind: ConnectorAuthKind;
    accountId: string | null;
    accountLabel: string | null;
    scopes: string[];
    connectedAt: string;
    cursor?: Record<string, unknown>;
  },
): ConnectorMeta {
  const values = {
    connector: m.connector,
    authKind: m.authKind,
    accountId: m.accountId,
    accountLabel: m.accountLabel,
    scopesJson: JSON.stringify(m.scopes),
    cursorJson: JSON.stringify(m.cursor ?? {}),
    lastStatus: 'ok',
    connectedAt: m.connectedAt,
    lastCheckedAt: null,
  };
  db.insert(connectorTokensMeta)
    .values(values)
    .onConflictDoUpdate({
      target: connectorTokensMeta.connector,
      set: {
        authKind: values.authKind,
        accountId: values.accountId,
        accountLabel: values.accountLabel,
        scopesJson: values.scopesJson,
        cursorJson: values.cursorJson,
        lastStatus: values.lastStatus,
        connectedAt: values.connectedAt,
        lastCheckedAt: null,
      },
    })
    .run();
  const saved = getConnectorMeta(db, m.connector);
  if (!saved) throw new Error(`connector meta ${m.connector} was not saved`);
  return saved;
}

export function setConnectorCursor(
  db: OrcDb,
  connector: ConnectorKey,
  cursor: Record<string, unknown>,
): void {
  db.update(connectorTokensMeta)
    .set({ cursorJson: JSON.stringify(cursor) })
    .where(eq(connectorTokensMeta.connector, connector))
    .run();
}

export function setConnectorStatus(
  db: OrcDb,
  connector: ConnectorKey,
  status: ConnectorHealth,
  at: string,
): void {
  db.update(connectorTokensMeta)
    .set({ lastStatus: status, lastCheckedAt: at })
    .where(eq(connectorTokensMeta.connector, connector))
    .run();
}

export function deleteConnectorMeta(db: OrcDb, connector: ConnectorKey): void {
  db.delete(connectorTokensMeta).where(eq(connectorTokensMeta.connector, connector)).run();
}
