import { randomInt } from 'node:crypto';
import { safeEqual } from './classify.ts';

/** No look-alikes: no I, O, 0 or 1. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export interface PairingService {
  create(): { code: string; expiresAt: string };
  consume(code: string): boolean;
  activeUntil(): string | null;
}

/** One active code at a time, single use; `maxFailures` wrong attempts cancel it. */
export function createPairingService(
  o: { ttlMs?: () => number; maxFailures?: number; now?: () => number } = {},
): PairingService {
  const ttl = o.ttlMs ?? (() => 300_000);
  const maxFailures = o.maxFailures ?? 5;
  const now = o.now ?? Date.now;
  let active: { code: string; exp: number } | null = null;
  let failures = 0;

  const current = () => {
    if (active && active.exp <= now()) active = null;
    return active;
  };

  return {
    create() {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++)
        code += PAIRING_ALPHABET.charAt(randomInt(PAIRING_ALPHABET.length));
      active = { code, exp: now() + ttl() };
      failures = 0;
      return { code, expiresAt: new Date(active.exp).toISOString() };
    },
    consume(code) {
      const a = current();
      if (!a) return false;
      if (!safeEqual(code.trim().toUpperCase(), a.code)) {
        failures++;
        if (failures >= maxFailures) active = null;
        return false;
      }
      active = null;
      return true;
    },
    activeUntil() {
      const a = current();
      return a ? new Date(a.exp).toISOString() : null;
    },
  };
}
