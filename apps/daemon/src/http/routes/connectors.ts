import {
  ConfirmBody,
  ConnectorId,
  type ConnectorStatus,
  OAuthAppBody,
  type OrcConfig,
  TokenBody,
} from '@orc/api-contract';
import { redact } from '@orc/core';
import type { LinearConnector } from '../../connectors/linear/linear.ts';
import {
  createOAuthStateStore,
  type OAuthProvider,
  type OAuthStateStore,
  slackOAuthProvider,
} from '../../connectors/oauth.ts';
import type { SlackConnector } from '../../connectors/slack/slack.ts';
import { withTimeout } from '../../connectors/util.ts';
import type { DaemonContext } from '../../context.ts';
import {
  type ConnectorAuthKind,
  type ConnectorHealth,
  type ConnectorKey,
  deleteConnectorMeta,
  getConnectorMeta,
  setConnectorStatus,
  upsertConnectorMeta,
} from '../../db/repos/connectors.ts';
import { audited } from '../../services/audit/audit.ts';
import { ServiceError } from '../../services/errors.ts';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { readJson } from '../json.ts';
import { confirmOr409, need, requireLoopback, type Who, whoOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

export interface ConnectorRouteDeps {
  secrets: SecretStore;
  linear: LinearConnector;
  slack: SlackConnector;
  providers: Partial<Record<ConnectorKey, OAuthProvider>>;
  oauthState: OAuthStateStore;
  now?: () => Date;
}

const IDS: readonly ConnectorKey[] = ['linear', 'slack'];
const NAMES: Record<ConnectorKey, string> = { linear: 'Linear', slack: 'Slack' };
const TOKEN_FORMAT: Record<ConnectorKey, RegExp> = {
  linear: /^lin_(api|oauth)_[A-Za-z0-9_]+$/,
  slack: /^xoxp-[A-Za-z0-9-]+$/,
};

function parseId(raw: string): ConnectorKey {
  const r = ConnectorId.safeParse(raw);
  if (!r.success) throw new ServiceError('not_found', 404, 'unknown connector');
  return r.data;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui;padding:2rem"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/settings">Back to Settings</a></p></body></html>`;
}

const redirectUriFor = (cfg: OrcConfig, id: ConnectorKey) => cfg.connectors[id].redirectUri;

/**
 * Connector status, token paste, OAuth app, authorize/callback and disconnect.
 *
 * Registered from `registerAllRoutes` with no `deps`: the secret store and both connectors are
 * then read off `ctx` per request (503 while unwired). Tests pass `deps` to use fakes. The state
 * store is created once here so `authorize` and `callback` share it.
 */
export function registerConnectorRoutes(app: OrcApp, ctx: DaemonContext, deps?: ConnectorRouteDeps): void {
  const oauthState = deps?.oauthState ?? createOAuthStateStore();
  const providers: Partial<Record<ConnectorKey, OAuthProvider>> = deps?.providers ?? {
    slack: slackOAuthProvider(),
  };
  const secrets = () => deps?.secrets ?? need(ctx.secrets, 'secrets');
  const linear = () => deps?.linear ?? need(ctx.linear, 'linear');
  const slack = () => deps?.slack ?? need(ctx.slack, 'slack');
  const nowIso = () => (deps?.now ? deps.now() : new Date()).toISOString();
  const connectorOf = (id: ConnectorKey) => (id === 'linear' ? linear() : slack());

  async function identify(id: ConnectorKey): Promise<{ accountId: string; label: string }> {
    connectorOf(id).invalidate();
    if (id === 'linear') {
      const me = await linear().me();
      return { accountId: me.id, label: `${me.name} <${me.email}>` };
    }
    const me = await slack().me();
    return { accountId: me.userId, label: me.label };
  }

  async function oauthApp(id: ConnectorKey): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientId = await secrets().get(`${id}.client_id`);
    const clientSecret = await secrets().get(`${id}.client_secret`);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  async function statusOf(id: ConnectorKey): Promise<ConnectorStatus> {
    const meta = getConnectorMeta(ctx.db, id);
    const oauthConfigured = providers[id] !== undefined && (await oauthApp(id)) !== null;
    if (!meta) {
      return {
        id,
        connected: false,
        status: 'unauthenticated',
        authKind: null,
        accountLabel: null,
        connectedAt: null,
        lastCheckedAt: null,
        oauthConfigured,
      };
    }
    let status: ConnectorHealth;
    try {
      status = await withTimeout(connectorOf(id).status(), 5000, `${id} status`);
    } catch {
      status = 'error';
    }
    const at = nowIso();
    setConnectorStatus(ctx.db, id, status, at);
    return {
      id,
      connected: true,
      status,
      authKind: meta.authKind,
      accountLabel: meta.accountLabel,
      connectedAt: meta.connectedAt,
      lastCheckedAt: at,
      oauthConfigured,
    };
  }

  /**
   * Writes the token to the secret store, then verifies it with `me()`. On failure the previous
   * token is restored (or removed) and the caller's `audited` wrapper records the error.
   */
  async function saveToken(
    id: ConnectorKey,
    token: string,
    authKind: ConnectorAuthKind,
    extras: { refreshToken?: string | null; expiresInSec?: number | null; scopes?: string[] },
  ): Promise<string> {
    const store = secrets();
    const previous = await store.get(`${id}.token`);
    await store.set(`${id}.token`, token);
    let ident: { accountId: string; label: string };
    try {
      ident = await identify(id);
    } catch {
      if (previous) await store.set(`${id}.token`, previous);
      else await store.delete(`${id}.token`);
      connectorOf(id).invalidate();
      throw new ServiceError('invalid_token', 400, `${NAMES[id]} rejected the token`);
    }
    if (extras.refreshToken) await store.set(`${id}.refresh_token`, extras.refreshToken);
    else await store.delete(`${id}.refresh_token`);
    const cursor = extras.expiresInSec
      ? { tokenExpiresAt: new Date(Date.now() + extras.expiresInSec * 1000).toISOString() }
      : {};
    upsertConnectorMeta(ctx.db, {
      connector: id,
      authKind,
      accountId: ident.accountId,
      accountLabel: ident.label,
      scopes: extras.scopes ?? [],
      connectedAt: nowIso(),
      cursor,
    });
    return ident.label;
  }

  /** One `connector.connect` entry per attempt; the params never carry the token. */
  const connectAudited = <T>(who: Who, id: ConnectorKey, authKind: ConnectorAuthKind, fn: () => Promise<T>) =>
    audited(ctx.audit, { ...who, action: 'connector.connect', target: id, params: { authKind } }, fn);

  app.get('/api/connectors', async (c) => {
    requireLoopback(c);
    return c.json(await Promise.all(IDS.map(statusOf)));
  });

  app.post('/api/connectors/:id/token', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const { token } = await readJson(c, TokenBody);
    const authKind: ConnectorAuthKind =
      id === 'slack' ? 'user_token' : token.startsWith('lin_oauth_') ? 'oauth' : 'api_key';
    await connectAudited(whoOf(c), id, authKind, async () => {
      if (!TOKEN_FORMAT[id].test(token)) {
        throw new ServiceError(
          'invalid_token_format',
          400,
          id === 'slack' ? 'expected a Slack user token (xoxp-…)' : 'expected a Linear API key (lin_api_…)',
        );
      }
      await saveToken(id, token, authKind, {});
    });
    return c.json(await statusOf(id));
  });

  app.post('/api/connectors/:id/app', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const body = await readJson(c, OAuthAppBody);
    await audited(
      ctx.audit,
      { ...whoOf(c), action: 'connector.configure', target: id, params: { clientId: body.clientId } },
      async () => {
        await secrets().set(`${id}.client_id`, body.clientId);
        await secrets().set(`${id}.client_secret`, body.clientSecret);
      },
    );
    return c.json({ ok: true as const });
  });

  app.get('/api/connectors/:id/authorize', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const provider = providers[id];
    if (!provider)
      throw new ServiceError('not_found', 404, `${NAMES[id]} has no OAuth flow here; paste a token instead`);
    const creds = await oauthApp(id);
    if (!creds)
      throw new ServiceError('oauth_not_configured', 409, 'save the OAuth client id and secret first');
    const state = oauthState.create(id);
    return c.json({
      url: provider.authorizeUrl({
        clientId: creds.clientId,
        redirectUri: redirectUriFor(ctx.config(), id),
        state,
      }),
    });
  });

  // Public (no token, GET only; see PUBLIC_API_PATHS): the browser arrives here from the provider.
  // The one-time `state` is the only guard, so it is consumed before anything else happens.
  app.get('/api/connectors/:id/callback', async (c) => {
    const parsed = ConnectorId.safeParse(c.req.param('id'));
    if (!parsed.success) return c.html(page('Not connected', 'Unknown connector.'), 404);
    const id = parsed.data;
    const q = c.req.query();
    if (q.error) return c.html(page('Not connected', redact(`${NAMES[id]} returned: ${q.error}`)), 400);
    const stateOk = q.state ? oauthState.consume(q.state, id) : false;
    if (!stateOk || !q.code) {
      return c.html(
        page(
          'Not connected',
          'This link expired or was already used. Start again from Settings → Connectors.',
        ),
        400,
      );
    }
    const provider = providers[id];
    const creds = await oauthApp(id);
    if (!provider || !creds) return c.html(page('Not connected', 'The OAuth app is not configured.'), 409);
    const code = q.code;
    try {
      const label = await connectAudited(
        { actor: 'user', actorDetail: 'oauth callback' },
        id,
        'oauth',
        async () => {
          const tokens = await provider.exchange({
            ...creds,
            code,
            redirectUri: redirectUriFor(ctx.config(), id),
          });
          return saveToken(id, tokens.accessToken, 'oauth', {
            refreshToken: tokens.refreshToken,
            expiresInSec: tokens.expiresInSec,
            scopes: tokens.scopes,
          });
        },
      );
      return c.html(page('Connected', `${NAMES[id]} is connected as ${label}. You can close this tab.`));
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const message = redact(raw.split(creds.clientSecret).join('[redacted]').split(code).join('[redacted]'));
      return c.html(page('Not connected', message), 400);
    }
  });

  app.delete('/api/connectors/:id', async (c) => {
    requireLoopback(c);
    const id = parseId(c.req.param('id'));
    const { confirm } = await readJson(c, ConfirmBody);
    confirmOr409(
      confirm,
      `Disconnect ${id}? The token is removed from the Keychain and the app stops posting and polling.`,
    );
    await audited(
      ctx.audit,
      { ...whoOf(c), action: 'connector.disconnect', target: id, params: {} },
      async () => {
        await secrets().delete(`${id}.token`);
        await secrets().delete(`${id}.refresh_token`);
        deleteConnectorMeta(ctx.db, id);
        connectorOf(id).invalidate();
      },
    );
    return c.json({ ok: true as const });
  });
}
