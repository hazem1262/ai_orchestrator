import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

/** Reads `$ORC_HOME/vapid.json`, or generates and writes it (mode 0600) on first use. */
export function loadOrCreateVapidKeys(
  orcHome: string,
  gen: () => { publicKey: string; privateKey: string } = () => webpush.generateVAPIDKeys(),
  now: () => Date = () => new Date(),
): VapidKeys {
  const file = join(orcHome, 'vapid.json');
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      chmodSync(file, 0o600);
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        createdAt: parsed.createdAt ?? now().toISOString(),
      };
    }
  }
  const k = gen();
  const keys: VapidKeys = {
    publicKey: k.publicKey,
    privateKey: k.privateKey,
    createdAt: now().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}
