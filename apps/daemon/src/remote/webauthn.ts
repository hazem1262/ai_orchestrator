import type { OrcConfig } from '@orc/api-contract';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { OrcDb } from '../db/client.ts';
import {
  getWebauthnCredential,
  insertWebauthnCredential,
  listWebauthnCredentials,
  updateWebauthnCounter,
} from '../db/repos/remote.ts';
import { ServiceError } from '../services/errors.ts';
import type { DeviceService } from './devices.ts';
import type { StepUpStore } from './step-up.ts';

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const defaultWebAuthnLib: WebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

/** A device may add its passkey only this long after pairing; the pairing code is the desktop's approval. */
export const REGISTRATION_WINDOW_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 120_000;

export interface WebAuthnService {
  registrationOptions(deviceId: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(deviceId: string, response: RegistrationResponseJSON): Promise<{ credentialId: string }>;
  stepUpOptions(deviceId: string): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyStepUp(deviceId: string, response: AuthenticationResponseJSON): Promise<{ validUntil: string }>;
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Transports = NonNullable<Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports']>;
const transportsOf = (t: string[]) => t as Transports;

/**
 * Passkeys for paired remote devices. The RP ID is the hostname of `remote.origin` (the MagicDNS
 * name) and the expected origin is `remote.origin`, so passkeys are always created on the
 * Tailscale origin: WebAuthn refuses IP-address RP IDs, and a `localhost` passkey would not work
 * on the phone. Challenges are per device, single use and valid for two minutes.
 */
export function createWebAuthnService(d: {
  db: OrcDb;
  config: () => OrcConfig;
  devices: DeviceService;
  stepUp: StepUpStore;
  lib?: WebAuthnLib;
  now?: () => number;
}): WebAuthnService {
  const lib = d.lib ?? defaultWebAuthnLib;
  const now = d.now ?? Date.now;
  const challenges = new Map<string, { kind: 'register' | 'stepup'; challenge: string; exp: number }>();

  function rp(): { origin: string; rpID: string; userName: string } {
    const cfg = d.config().remote;
    if (!cfg.enabled || !cfg.origin)
      throw new ServiceError('remote_disabled', 403, 'remote access is disabled');
    const url = new URL(cfg.origin);
    return { origin: url.origin, rpID: url.hostname, userName: cfg.allowedLogin ?? 'orchestrator' };
  }

  function device(id: string) {
    const dev = d.devices.get(id);
    if (!dev || dev.revokedAt !== null) throw new ServiceError('unauthorized', 401, 'unknown device');
    return dev;
  }

  function takeChallenge(deviceId: string, kind: 'register' | 'stepup'): string {
    const c = challenges.get(deviceId);
    challenges.delete(deviceId);
    if (!c || c.kind !== kind || c.exp <= now()) {
      throw new ServiceError('invalid_state', 400, 'challenge expired; try again');
    }
    return c.challenge;
  }

  return {
    async registrationOptions(deviceId) {
      const dev = device(deviceId);
      const { rpID, userName } = rp();
      const tooLate = now() - Date.parse(dev.createdAt) > REGISTRATION_WINDOW_MS;
      if (listWebauthnCredentials(d.db, deviceId).length > 0 || tooLate) {
        throw new ServiceError(
          'registration_window_closed',
          403,
          'passkeys can only be added right after pairing; pair the device again',
        );
      }
      const options = await lib.generateRegistrationOptions({
        rpName: 'Orchestrator',
        rpID,
        userName,
        userDisplayName: `${userName} (${dev.name})`,
        userID: new TextEncoder().encode(dev.id),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: CHALLENGE_TTL_MS,
      });
      challenges.set(deviceId, {
        kind: 'register',
        challenge: options.challenge,
        exp: now() + CHALLENGE_TTL_MS,
      });
      return options;
    },

    async verifyRegistration(deviceId, response) {
      device(deviceId);
      const { origin, rpID } = rp();
      const expectedChallenge = takeChallenge(deviceId, 'register');
      let result: Awaited<ReturnType<WebAuthnLib['verifyRegistrationResponse']>>;
      try {
        result = await lib.verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (e) {
        throw new ServiceError('validation_failed', 400, `passkey registration failed: ${message(e)}`);
      }
      if (!result.verified)
        throw new ServiceError('validation_failed', 400, 'passkey registration was not verified');
      const cred = result.registrationInfo.credential;
      insertWebauthnCredential(d.db, {
        id: cred.id,
        deviceId,
        publicKey: toB64(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ?? [],
        createdAt: new Date(now()).toISOString(),
        lastUsedAt: null,
      });
      return { credentialId: cred.id };
    },

    async stepUpOptions(deviceId) {
      device(deviceId);
      const { rpID } = rp();
      const creds = listWebauthnCredentials(d.db, deviceId);
      if (creds.length === 0) {
        throw new ServiceError('unknown_credential', 403, 'no passkey is registered for this device');
      }
      const options = await lib.generateAuthenticationOptions({
        rpID,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: transportsOf(c.transports) })),
        userVerification: 'required',
        timeout: CHALLENGE_TTL_MS,
      });
      challenges.set(deviceId, {
        kind: 'stepup',
        challenge: options.challenge,
        exp: now() + CHALLENGE_TTL_MS,
      });
      return options;
    },

    async verifyStepUp(deviceId, response) {
      device(deviceId);
      const { origin, rpID } = rp();
      const expectedChallenge = takeChallenge(deviceId, 'stepup');
      const stored = getWebauthnCredential(d.db, response.id);
      if (!stored || stored.deviceId !== deviceId) {
        throw new ServiceError('unknown_credential', 403, 'this passkey does not belong to this device');
      }
      let result: Awaited<ReturnType<WebAuthnLib['verifyAuthenticationResponse']>>;
      try {
        result = await lib.verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: stored.id,
            publicKey: fromB64(stored.publicKey),
            counter: stored.counter,
            transports: transportsOf(stored.transports),
          },
          requireUserVerification: true,
        });
      } catch (e) {
        throw new ServiceError('step_up_failed', 403, `passkey check failed: ${message(e)}`);
      }
      if (!result.verified) throw new ServiceError('step_up_failed', 403, 'passkey check failed');
      updateWebauthnCounter(
        d.db,
        stored.id,
        result.authenticationInfo.newCounter,
        new Date(now()).toISOString(),
      );
      return { validUntil: d.stepUp.grant(deviceId) };
    },
  };
}
