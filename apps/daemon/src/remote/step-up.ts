export interface StepUpStore {
  grant(deviceId: string): string;
  valid(deviceId: string): boolean;
  validUntil(deviceId: string): string | null;
  revoke(deviceId: string): void;
}

/** In-memory, per device: a daemon restart drops every step-up. */
export function createStepUpStore(o: { ttlMs: () => number; now?: () => number }): StepUpStore {
  const now = o.now ?? Date.now;
  const grants = new Map<string, number>();
  const until = (deviceId: string): number | null => {
    const exp = grants.get(deviceId);
    if (exp === undefined) return null;
    if (exp <= now()) {
      grants.delete(deviceId);
      return null;
    }
    return exp;
  };
  return {
    grant(deviceId) {
      const exp = now() + o.ttlMs();
      grants.set(deviceId, exp);
      return new Date(exp).toISOString();
    },
    valid: (deviceId) => until(deviceId) !== null,
    validUntil(deviceId) {
      const exp = until(deviceId);
      return exp === null ? null : new Date(exp).toISOString();
    },
    revoke(deviceId) {
      grants.delete(deviceId);
    },
  };
}
