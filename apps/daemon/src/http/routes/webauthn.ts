import { WebAuthnVerifyBody } from '@orc/api-contract';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { DaemonContext } from '../../context.ts';
import type { WebAuthnService } from '../../remote/webauthn.ts';
import { audited } from '../../services/audit/audit.ts';
import { readJson } from '../json.ts';
import { need, requireRemoteDevice } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

/**
 * Passkey registration and step-up for paired remote devices (`403 remote_only` otherwise).
 * Registered from `registerAllRoutes` with no `deps`: the service is then read off
 * `ctx.remoteAccess` per request (503 while unwired).
 */
export function registerWebAuthnRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  deps?: { webauthn: WebAuthnService },
): void {
  const webauthn = () => deps?.webauthn ?? need(ctx.remoteAccess, 'remote access').webauthn;
  app.post('/api/webauthn/register/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await webauthn().registrationOptions(r.deviceId));
  });

  app.post('/api/webauthn/register/verify', async (c) => {
    const r = requireRemoteDevice(c);
    const { response } = await readJson(c, WebAuthnVerifyBody);
    const out = await audited(
      need(ctx.audit, 'audit'),
      {
        actor: 'remote',
        actorDetail: `${r.deviceName ?? 'device'} (${r.login})`,
        action: 'webauthn.register',
        target: r.deviceId,
        params: {},
      },
      () => webauthn().verifyRegistration(r.deviceId, response as unknown as RegistrationResponseJSON),
    );
    return c.json(out);
  });

  app.post('/api/webauthn/stepup/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await webauthn().stepUpOptions(r.deviceId));
  });

  app.post('/api/webauthn/stepup/verify', async (c) => {
    const r = requireRemoteDevice(c);
    const { response } = await readJson(c, WebAuthnVerifyBody);
    return c.json(
      await webauthn().verifyStepUp(r.deviceId, response as unknown as AuthenticationResponseJSON),
    );
  });
}
