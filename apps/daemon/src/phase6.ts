import type { LinearApi } from './connectors/linear/api.ts';
import { createLinearAssignedPoller } from './connectors/linear/assigned-poller.ts';
import { createLinearConnector, type LinearConnector } from './connectors/linear/linear.ts';
import type { SlackApi } from './connectors/slack/api.ts';
import { createSlackMentionPoller } from './connectors/slack/mention-poller.ts';
import { createSlackConnector, type SlackConnector } from './connectors/slack/slack.ts';
import { createStreamEnricher, createStreamTitleStore } from './connectors/stream-enricher.ts';
import type { DaemonContext } from './context.ts';
import { need } from './http/p6-util.ts';
import type { RemoteGuardDeps } from './http/remote-guard.ts';
import { createSlackDmChannel } from './notify/slack-dm.ts';
import { loadOrCreateVapidKeys, type VapidKeys } from './notify/vapid.ts';
import { createWebPushChannel, type PushSender, type WebPushChannel } from './notify/webpush.ts';
import { type AwayService, createAwayService } from './remote/away.ts';
import { createDeviceService, type DeviceService } from './remote/devices.ts';
import { createPairingService, type PairingService } from './remote/pairing.ts';
import { createStepUpStore, type StepUpStore } from './remote/step-up.ts';
import { createFunnelWatch, type FunnelWatch, type RunCommand } from './remote/tailscale.ts';
import { createWebAuthnService, type WebAuthnService } from './remote/webauthn.ts';
import { createSessionActions, type SessionActions } from './services/remote/session-actions.ts';
import { createSlackBridge, type SlackBridge } from './services/remote/slack-bridge.ts';
import { createSecretStore, type SecretStore } from './services/secrets/secret-store.ts';
import { createShareService, type ShareService } from './services/share/share.ts';

/**
 * Overrides for the parts of Phase 6 that reach outside the process. Production passes none of
 * them; every test that builds Phase 6 passes all of them, so no test touches the Keychain,
 * Linear, Slack, a push service, `ioreg` or `tailscale`.
 */
export interface Phase6Options {
  secrets?: SecretStore;
  linearApi?: (token: string) => LinearApi;
  slackApi?: (token: string | null) => SlackApi;
  pushSender?: PushSender;
  idle?: () => Promise<number | null>;
  run?: RunCommand;
}

export interface Phase6 {
  secrets: SecretStore;
  linear: LinearConnector;
  slack: SlackConnector;
  share: ShareService;
  actions: SessionActions;
  bridge: SlackBridge;
  away: AwayService;
  devices: DeviceService;
  pairing: PairingService;
  stepUp: StepUpStore;
  funnel: FunnelWatch;
  webauthn: WebAuthnService;
  keys: VapidKeys;
  push: WebPushChannel;
  guardDeps: RemoteGuardDeps;
  /** Starts the Funnel watch, away mode, the Slack bridge and the three pollers. Idempotent. */
  start(): void;
  /** Stops everything `start` started. Idempotent. */
  stop(): void;
}

/**
 * Builds every Phase 6 service, sets them on `ctx` (the routes in `registerAllRoutes` read them
 * per request) and registers the `webpush` and `slack_dm` notify channels. Needs `ctx.notifier`,
 * so it runs after `startPhase2`. Nothing runs in the background until `start()`, and every
 * timer it starts is `unref`'d.
 */
export function createPhase6(ctx: DaemonContext, o: Phase6Options = {}): Phase6 {
  const notifier = need(ctx.notifier, 'notifier');
  const secrets = o.secrets ?? createSecretStore();
  const linear = createLinearConnector({ secrets, ...(o.linearApi ? { api: o.linearApi } : {}) });
  const slack = createSlackConnector({ secrets, ...(o.slackApi ? { api: o.slackApi } : {}) });
  const share = createShareService({ ctx, linear, slack });
  const actions = createSessionActions(ctx);

  const devices = createDeviceService(ctx.db);
  const stepUp = createStepUpStore({ ttlMs: () => ctx.config().remote.stepUpTtlSec * 1000 });
  const pairing = createPairingService({ ttlMs: () => ctx.config().remote.pairingTtlSec * 1000 });
  const funnel = createFunnelWatch({ ...(o.run ? { run: o.run } : {}), log: ctx.log });
  const webauthn = createWebAuthnService({ db: ctx.db, config: ctx.config, devices, stepUp });

  const keys = loadOrCreateVapidKeys(ctx.paths.orcHome);
  const push = createWebPushChannel({
    db: ctx.db,
    keys,
    config: ctx.config,
    log: ctx.log,
    ...(o.pushSender ? { send: o.pushSender } : {}),
  });
  const bridge = createSlackBridge({ ctx, slack, actions });
  notifier.register(push);
  notifier.register(createSlackDmChannel(bridge));

  const away = createAwayService({
    config: ctx.config,
    notifier,
    bus: ctx.bus,
    ...(o.idle ? { idle: o.idle } : {}),
  });
  const jobs = [
    funnel,
    away,
    bridge,
    createLinearAssignedPoller({ ctx, linear }),
    createSlackMentionPoller({ ctx, slack }),
    createStreamEnricher({ ctx, linear, store: createStreamTitleStore(ctx) }),
  ];

  ctx.secrets = secrets;
  ctx.linear = linear;
  ctx.slack = slack;
  ctx.share = share;
  ctx.sessionActions = actions;
  ctx.away = away;
  ctx.remoteAccess = { devices, pairing, stepUp, funnel, webauthn, vapid: keys, webpush: push };

  return {
    secrets,
    linear,
    slack,
    share,
    actions,
    bridge,
    away,
    devices,
    pairing,
    stepUp,
    funnel,
    webauthn,
    keys,
    push,
    guardDeps: { config: ctx.config, devices, stepUp, funnel },
    start() {
      for (const j of jobs) j.start();
    },
    stop() {
      for (const j of jobs) j.stop();
    },
  };
}
