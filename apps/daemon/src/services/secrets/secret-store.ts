import { AsyncEntry } from '@napi-rs/keyring';

export const SECRET_SERVICE = 'orchestrator';
export type SecretKey = `${'linear' | 'slack'}.${'token' | 'client_id' | 'client_secret' | 'refresh_token'}`;

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function assertKey(key: string): void {
  if (!/^[a-z]+\.[a-z_]+$/.test(key)) throw new Error(`invalid secret key: ${key}`);
}

function assertValue(value: string): void {
  if (value.length === 0) throw new Error('empty secret');
}

function isNoEntry(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no (matching )?entry|not found|could not be found/i.test(message);
}

/** macOS Keychain (generic password), service "orchestrator", account = key. */
export function createSecretStore(service: string = SECRET_SERVICE): SecretStore {
  return {
    async get(key) {
      assertKey(key);
      try {
        return (await new AsyncEntry(service, key).getPassword()) ?? null;
      } catch (e) {
        if (isNoEntry(e)) return null;
        throw e;
      }
    },
    async set(key, value) {
      assertKey(key);
      assertValue(value);
      await new AsyncEntry(service, key).setPassword(value);
    },
    async delete(key) {
      assertKey(key);
      try {
        await new AsyncEntry(service, key).deleteCredential();
      } catch (e) {
        if (!isNoEntry(e)) throw e;
      }
    },
  };
}

export function createMemorySecretStore(
  initial: Record<string, string> = {},
): SecretStore & { dump(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) {
      assertKey(key);
      return values.get(key) ?? null;
    },
    async set(key, value) {
      assertKey(key);
      assertValue(value);
      values.set(key, value);
    },
    async delete(key) {
      assertKey(key);
      values.delete(key);
    },
    dump: () => Object.fromEntries(values),
  };
}
