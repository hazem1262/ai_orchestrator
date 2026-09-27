import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Non-secret metadata only. Tokens live in the Keychain (SecretStore).
export const connectorTokensMeta = sqliteTable('connector_tokens_meta', {
  connector: text('connector').primaryKey(),
  authKind: text('auth_kind').notNull(),
  accountId: text('account_id'),
  accountLabel: text('account_label'),
  scopesJson: text('scopes_json').notNull().default('[]'),
  cursorJson: text('cursor_json').notNull().default('{}'),
  lastStatus: text('last_status').notNull().default('ok'),
  connectedAt: text('connected_at').notNull(),
  lastCheckedAt: text('last_checked_at'),
});

export const remoteDevices = sqliteTable('remote_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  login: text('login'),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
});

export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => remoteDevices.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transportsJson: text('transports_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('webauthn_credentials_device_idx').on(t.deviceId)],
);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').references(() => remoteDevices.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: text('created_at').notNull(),
  lastOkAt: text('last_ok_at'),
  failures: integer('failures').notNull().default(0),
});

export const slackThreads = sqliteTable(
  'slack_threads',
  {
    inboxItemId: text('inbox_item_id').primaryKey(),
    sessionPk: text('session_pk'),
    channel: text('channel').notNull(),
    rootTs: text('root_ts').notNull(),
    lastSeenTs: text('last_seen_ts').notNull(),
    appTsJson: text('app_ts_json').notNull().default('[]'),
    reactionsDoneJson: text('reactions_done_json').notNull().default('[]'),
    state: text('state').notNull().default('open'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('slack_threads_state_idx').on(t.state)],
);
