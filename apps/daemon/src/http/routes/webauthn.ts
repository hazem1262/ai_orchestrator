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
 * Not mounted by `registerAllRoutes` yet: Task 20's `createPhase6().register` mounts it with the
 * other Phase 6 routes.
 */
export function registerWebAuthnRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  d: { webauthn: WebAuthnService },
): void {
  app.post('/api/webauthn/register/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await d.webauthn.registrationOptions(r.deviceId));
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
      () => d.webauthn.verifyRegistration(r.deviceId, response as unknown as RegistrationResponseJSON),
    );
    return c.json(out);
  });

  app.post('/api/webauthn/stepup/options', async (c) => {
    const r = requireRemoteDevice(c);
    return c.json(await d.webauthn.stepUpOptions(r.deviceId));
  });

  app.post('/api/webauthn/stepup/verify', async (c) => {
    const r = requireRemoteDevice(c);
    const { response } = await readJson(c, WebAuthnVerifyBody);
    return c.json(
      await d.webauthn.verifyStepUp(r.deviceId, response as unknown as AuthenticationResponseJSON),
    );
  });
}
