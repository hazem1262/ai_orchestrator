import {
  ConfirmBody,
  PairBody,
  RemoteConfigBody,
  type RemoteDevice,
  type RemoteStatus,
} from '@orc/api-contract';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import type { DeviceService } from '../../remote/devices.ts';
import type { PairingService } from '../../remote/pairing.ts';
import type { StepUpStore } from '../../remote/step-up.ts';
import type { FunnelWatch } from '../../remote/tailscale.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { confirmOr409, need, remoteOf, requireLoopback, whoOf } from '../p6-util.ts';
import type { OrcApp, OrcEnv } from '../types.ts';

export interface RemoteRouteDeps {
  devices: DeviceService;
  pairing: PairingService;
  stepUp: StepUpStore;
  funnel: FunnelWatch;
}

/**
 * Remote status, config, pairing and devices. Each mutating route records its own audit entry.
 * Configuring, creating a pairing code and managing devices are loopback-only; redeeming a
 * pairing code is remote-only (the `public` remote policy lets an unpaired device reach it).
 */
export function registerRemoteRoutes(app: OrcApp, ctx: DaemonContext, d: RemoteRouteDeps): void {
  function status(c: Context<OrcEnv>): RemoteStatus {
    const cfg = ctx.config().remote;
    const r = remoteOf(c);
    return {
      enabled: cfg.enabled,
      origin: cfg.origin,
      allowedLogin: r ? null : cfg.allowedLogin,
      isRemote: r !== null,
      deviceId: r?.deviceId ?? null,
      stepUpValidUntil: r?.deviceId ? d.stepUp.validUntil(r.deviceId) : null,
      funnelDetected: d.funnel.detected(),
      pairingActiveUntil: r ? null : d.pairing.activeUntil(),
    };
  }

  app.get('/api/remote/status', (c) => c.json(status(c)));

  app.post('/api/remote/config', async (c) => {
    requireLoopback(c);
    const body = await readJson(c, RemoteConfigBody);
    if (body.enabled && (!body.origin || !body.allowedLogin)) {
      throw new ServiceError(
        'validation_failed',
        400,
        'origin and allowedLogin are required to enable remote access',
      );
    }
    need(
      ctx.updateConfig,
      'updateConfig',
    )((cfg) => ({
      ...cfg,
      remote: { ...cfg.remote, enabled: body.enabled, origin: body.origin, allowedLogin: body.allowedLogin },
    }));
    await d.funnel.refresh();
    ctx.audit.record({
      ...whoOf(c),
      action: 'remote.configure',
      target: body.origin,
      params: { enabled: body.enabled, allowedLogin: body.allowedLogin },
      result: 'ok',
      error: null,
    });
    return c.json(status(c));
  });

  app.post('/api/remote/pairing', (c) => {
    requireLoopback(c);
    const cfg = ctx.config().remote;
    if (!cfg.enabled || !cfg.origin || !cfg.allowedLogin?.trim()) {
      throw new ServiceError('remote_disabled', 409, 'enable remote access first');
    }
    const p = d.pairing.create();
    ctx.audit.record({
      ...whoOf(c),
      action: 'remote.pairing_code',
      target: null,
      params: { expiresAt: p.expiresAt },
      result: 'ok',
      error: null,
    });
    return c.json({ code: p.code, expiresAt: p.expiresAt, url: `${cfg.origin}/pair` });
  });

  app.post('/api/remote/pair', async (c) => {
    const r = remoteOf(c);
    if (!r)
      throw new ServiceError(
        'not_remote',
        400,
        'open the pairing page through the Tailscale address on the device',
      );
    const body = await readJson(c, PairBody);
    const detail = `${body.name} (${r.login})`;
    if (!d.pairing.consume(body.code)) {
      ctx.audit.record({
        actor: 'remote',
        actorDetail: detail,
        action: 'remote.pair',
        target: null,
        params: {},
        result: 'denied',
        error: 'invalid code',
      });
      throw new ServiceError('invalid_code', 403, 'wrong or expired pairing code');
    }
    const { device, token } = d.devices.create(body.name, r.login);
    ctx.audit.record({
      actor: 'remote',
      actorDetail: detail,
      action: 'remote.pair',
      target: device.id,
      params: { name: body.name },
      result: 'ok',
      error: null,
    });
    return c.json({ deviceId: device.id, deviceToken: token });
  });

  app.get('/api/remote/devices', (c) => {
    requireLoopback(c);
    return c.json(
      d.devices.list().map(
        (x): RemoteDevice => ({
          id: x.id,
          name: x.name,
          login: x.login,
          createdAt: x.createdAt,
          lastSeenAt: x.lastSeenAt,
          revokedAt: x.revokedAt,
          credentials: x.credentials,
        }),
      ),
    );
  });

  app.delete('/api/remote/devices/:id', async (c) => {
    requireLoopback(c);
    const id = c.req.param('id');
    const { confirm } = await readJson(c, ConfirmBody);
    const device = d.devices.get(id);
    if (!device) throw new ServiceError('not_found', 404, 'unknown device');
    confirmOr409(confirm, `Revoke ${device.name}? It loses access, its passkeys and its push subscriptions.`);
    d.devices.revoke(id);
    d.stepUp.revoke(id);
    ctx.audit.record({
      ...whoOf(c),
      action: 'remote.revoke',
      target: id,
      params: { name: device.name },
      result: 'ok',
      error: null,
    });
    return c.json({ ok: true as const });
  });
}
