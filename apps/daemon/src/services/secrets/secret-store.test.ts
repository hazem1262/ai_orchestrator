import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore, createSecretStore, SECRET_SERVICE } from './secret-store.ts';

/**
 * `@napi-rs/keyring` is replaced for the whole file with an in-memory fake. The factory never calls
 * `importOriginal`, so the native binding is never loaded and no test in this file can read or
 * write the real macOS Keychain. `keychain` records every `AsyncEntry` construction and call.
 */
const keychain = vi.hoisted(() => {
  const store = new Map<string, string>();
  const constructed: Array<{ service: string; username: string }> = [];
  const failures: { get?: Error; set?: Error; delete?: Error } = {};
  const id = (service: string, username: string) => `${service}\u0000${username}`;

  class FakeAsyncEntry {
    readonly service: string;
    readonly username: string;
    constructor(service: string, username: string) {
      this.service = service;
      this.username = username;
      constructed.push({ service, username });
    }
    async getPassword(): Promise<string | undefined> {
      if (failures.get) throw failures.get;
      return store.get(id(this.service, this.username));
    }
    async setPassword(password: string): Promise<void> {
      if (failures.set) throw failures.set;
      store.set(id(this.service, this.username), password);
    }
    async deleteCredential(): Promise<boolean> {
      if (failures.delete) throw failures.delete;
      return store.delete(id(this.service, this.username));
    }
  }

  return {
    FakeAsyncEntry,
    store,
    constructed,
    failures,
    id,
    reset() {
      store.clear();
      constructed.length = 0;
      delete failures.get;
      delete failures.set;
      delete failures.delete;
    },
  };
});

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: keychain.FakeAsyncEntry,
  Entry: class {
    constructor() {
      throw new Error('sync Entry must not be used in tests');
    }
  },
}));

beforeEach(() => {
  keychain.reset();
});

describe('keyring isolation', () => {
  it('resolves @napi-rs/keyring to the in-memory fake, never the native module', async () => {
    const mod = await import('@napi-rs/keyring');
    expect(mod.AsyncEntry).toBe(keychain.FakeAsyncEntry);
  });
});

describe('memory secret store', () => {
  it('gets, sets and deletes', async () => {
    const s = createMemorySecretStore({ 'slack.token': 'xoxp-1' });
    expect(await s.get('slack.token')).toBe('xoxp-1');
    await s.set('linear.token', 'lin_api_2');
    expect(s.dump()).toEqual({ 'slack.token': 'xoxp-1', 'linear.token': 'lin_api_2' });
    await s.delete('slack.token');
    await s.delete('slack.token');
    expect(await s.get('slack.token')).toBeNull();
  });

  it('rejects malformed keys and empty values', async () => {
    const s = createMemorySecretStore();
    await expect(s.get('../etc')).rejects.toThrow('invalid secret key');
    await expect(s.set('slack.token', '')).rejects.toThrow('empty secret');
  });

  it('never touches the keyring', async () => {
    const s = createMemorySecretStore();
    await s.set('slack.token', 'xoxp-1');
    await s.get('slack.token');
    await s.delete('slack.token');
    expect(keychain.constructed).toEqual([]);
  });
});

describe('keychain secret store (fake AsyncEntry)', () => {
  it('uses service "orchestrator" by default with the key as the account', async () => {
    expect(SECRET_SERVICE).toBe('orchestrator');
    const s = createSecretStore();
    await s.set('slack.token', 'xoxp-1');
    expect(keychain.store.get(keychain.id('orchestrator', 'slack.token'))).toBe('xoxp-1');
    expect(keychain.constructed).toEqual([{ service: 'orchestrator', username: 'slack.token' }]);
  });

  it('round-trips under a custom service', async () => {
    const s = createSecretStore('orchestrator-test');
    expect(await s.get('slack.token')).toBeNull();
    await s.set('slack.token', 'xoxp-test-value');
    expect(await s.get('slack.token')).toBe('xoxp-test-value');
    await s.delete('slack.token');
    expect(await s.get('slack.token')).toBeNull();
    await s.delete('slack.token');
    expect(keychain.constructed.every((c) => c.service === 'orchestrator-test')).toBe(true);
    expect(keychain.store.has(keychain.id('orchestrator', 'slack.token'))).toBe(false);
  });

  it('returns null when the keyring reports no entry', async () => {
    keychain.failures.get = new Error('No matching entry found in secure storage');
    expect(await createSecretStore().get('linear.token')).toBeNull();
  });

  it('treats a missing entry on delete as success', async () => {
    keychain.failures.delete = new Error('No matching entry found in secure storage');
    await expect(createSecretStore().delete('linear.token')).resolves.toBeUndefined();
  });

  it('propagates other keyring errors', async () => {
    const s = createSecretStore();
    keychain.failures.get = new Error('User interaction is not allowed');
    await expect(s.get('slack.token')).rejects.toThrow('User interaction is not allowed');
    keychain.failures.delete = new Error('User interaction is not allowed');
    await expect(s.delete('slack.token')).rejects.toThrow('User interaction is not allowed');
    keychain.failures.set = new Error('User interaction is not allowed');
    await expect(s.set('slack.token', 'x')).rejects.toThrow('User interaction is not allowed');
  });

  it('validates keys and values before opening a keyring entry', async () => {
    const s = createSecretStore();
    await expect(s.get('../etc')).rejects.toThrow('invalid secret key');
    await expect(s.set('Slack.Token', 'x')).rejects.toThrow('invalid secret key');
    await expect(s.delete('slack')).rejects.toThrow('invalid secret key');
    await expect(s.set('slack.token', '')).rejects.toThrow('empty secret');
    expect(keychain.constructed).toEqual([]);
  });
});
