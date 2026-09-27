import { AgncHandoffBody, AgncPromptBody, ConfirmBody } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { AgncConnector } from '../../connectors/agnc/agnc.ts';
import type { DaemonContext } from '../../context.ts';
import { audited } from '../../services/audit/audit.ts';
import { ServiceError } from '../../services/errors.ts';
import { remoteSlug } from '../../services/git/git-info.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readJson } from '../json.ts';
import { requireLoopback, whoOf } from '../p6-util.ts';
import { need, requireConfirmed } from '../p7-guard.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

/**
 * P7 AGNC. `ctx.agnc` is set by `createPhase7`; every route except the status answers
 * `409 not_enabled` while it is unset or `agnc.enabled` is off, before any body is read.
 * `prompt` and `handoff` are the only paths that send user content to AGNC: both need
 * `confirm: true`, and the text is redacted before it leaves the daemon. Neither touches a local
 * PTY. Remote session text comes back through `redactedJson`.
 */
export function registerAgncRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = (): AgncConnector => {
    if (!ctx.config().agnc.enabled) throw new ServiceError('not_enabled', 409, 'AGNC is not enabled');
    return need(ctx.agnc, 'AGNC connector');
  };

  app.get('/api/connectors/agnc/status', async (c) => {
    const cfg = ctx.config().agnc;
    if (!cfg.enabled || !ctx.agnc) {
      return c.json({ enabled: cfg.enabled, status: 'disabled' as const, url: cfg.url, sessions: 0 });
    }
    const sessions = ctx.sessions.list({ source: 'agnc', limit: 200 }).items.length;
    return c.json({ enabled: true, status: await ctx.agnc.status(), url: cfg.url, sessions });
  });

  app.post('/api/connectors/agnc/connect', async (c) => {
    const agnc = svc();
    requireLoopback(c);
    const res = await audited(
      ctx.audit,
      { ...whoOf(c), action: 'agnc.connect', target: ctx.config().agnc.url, params: { step: 'begin' } },
      () => agnc.beginAuth(),
    );
    return c.json(res);
  });

  app.post('/api/connectors/agnc/disconnect', async (c) => {
    const agnc = svc();
    requireLoopback(c);
    const body = await readJson(c, ConfirmBody);
    requireConfirmed(
      body,
      'Disconnect AGNC? The AGNC tokens are removed from the Keychain and remote sessions stop updating.',
    );
    await audited(
      ctx.audit,
      { ...whoOf(c), action: 'agnc.disconnect', target: ctx.config().agnc.url, params: {} },
      () => (agnc.signOut ? agnc.signOut() : agnc.disconnect()),
    );
    return c.json({ ok: true as const });
  });

  app.get('/api/agnc/sessions/:id/messages', async (c) => {
    const agnc = svc();
    return redactedJson(c, await agnc.listMessages(c.req.param('id')));
  });

  app.get('/api/agnc/sessions/:id/events', async (c) => {
    const agnc = svc();
    return redactedJson(c, await agnc.listEvents(c.req.param('id'), c.req.query('cursor') || undefined));
  });

  app.post('/api/agnc/sessions/:id/prompt', async (c) => {
    const agnc = svc();
    const body = await readJson(c, AgncPromptBody);
    const id = c.req.param('id');
    const prompt = redact(body.prompt);
    requireConfirmed(body, `Send this prompt to AGNC session ${id}? It leaves this Mac.`, { prompt });
    await audited(
      ctx.audit,
      {
        ...whoOf(c),
        action: 'agnc.prompt',
        target: `agnc:${id}`,
        params: { model: body.model ?? null, chars: prompt.length },
      },
      () => agnc.sendPrompt(id, prompt, body.model),
    );
    return c.json({ ok: true as const });
  });

  app.post('/api/agnc/handoff', async (c) => {
    const agnc = svc();
    const body = await readJson(c, AgncHandoffBody);
    const handoffs = need(ctx.handoffs, 'the handoff service');
    const session = ctx.sessions.get(body.source, body.id);
    if (!session) throw new ServiceError('not_found', 404, `session ${body.source}:${body.id} not found`);
    const slug =
      body.repoOwner && body.repoName
        ? { owner: body.repoOwner, name: body.repoName }
        : await remoteSlug(session.startCwd);
    if (!slug) {
      throw new ServiceError(
        'validation_failed',
        400,
        'could not work out the GitHub repo from the session directory; pass repoOwner and repoName',
      );
    }
    const title = redact(session.name ?? `Handoff ${body.id}`);
    const repo = `${slug.owner}/${slug.name}`;
    requireConfirmed(
      body,
      `Create an AGNC session in ${repo} from the handoff of "${title}"? The handoff summary leaves this Mac.`,
      { repo, title },
    );
    const pk = sessionPk(body.source, body.id);
    const created = await audited(
      ctx.audit,
      { ...whoOf(c), action: 'agnc.create', target: `agnc:${repo}`, params: { from: pk, repo } },
      async () => {
        const handoff = await handoffs.generate(pk);
        return agnc.createSession({
          repoOwner: slug.owner,
          repoName: slug.name,
          baseBranch: body.baseBranch,
          title,
          initialPrompt: redact(handoffs.toMarkdown(handoff)),
          model: body.model,
        });
      },
    );
    return redactedJson(c, created, 201);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui;padding:2rem"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/settings">Back to Settings</a></p></body></html>`;
}

/** OAuth `state` and `code` values are short URL-safe strings; anything else is rejected unread. */
const OAUTH_PARAM = /^[A-Za-z0-9._~-]{1,512}$/;

/**
 * Public (no token, GET only; see `PUBLIC_API_PATHS`): the browser arrives here from AGNC. The
 * host check still applies. The connector compares `state` with the one the provider sent before
 * anything else happens, and an OAuth flow can be finished only once. The page never shows the
 * code, the state or a token, and every message on it is redacted.
 */
export function registerAgncOAuthRoute(app: OrcApp, ctx: DaemonContext): void {
  app.get('/oauth/agnc/callback', async (c) => {
    const q = c.req.query();
    if (q.error) return c.html(page('AGNC not connected', redact(`AGNC returned: ${q.error}`)), 400);
    const code = q.code ?? '';
    const state = q.state ?? '';
    if (!OAUTH_PARAM.test(code) || !OAUTH_PARAM.test(state)) {
      return c.html(page('AGNC not connected', 'The link is missing its code or state.'), 400);
    }
    const agnc = ctx.config().agnc.enabled ? ctx.agnc : undefined;
    if (!agnc)
      return c.html(page('AGNC not connected', 'AGNC is not enabled (agnc.enabled in the config).'), 409);
    try {
      await audited(
        ctx.audit,
        {
          actor: 'user',
          actorDetail: 'oauth callback',
          action: 'agnc.connect',
          target: ctx.config().agnc.url,
          params: { step: 'finish' },
        },
        // Scrubbed before `audited` stores the error, so neither the code nor the state is logged.
        () =>
          agnc.finishAuth(code, state).catch((e: unknown) => {
            if (e instanceof ServiceError) throw e;
            const raw = e instanceof Error ? e.message : String(e);
            throw new Error(redact(raw.split(code).join('[redacted]').split(state).join('[redacted]')));
          }),
      );
      return c.html(page('AGNC connected', 'AGNC is connected. You can close this tab.'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.log.warn({ err: message }, 'agnc oauth callback failed');
      const expired = e instanceof ServiceError && e.code === 'invalid_state';
      return c.html(
        page(
          'AGNC not connected',
          expired
            ? 'This link expired or was already used. Start again from Settings → Connectors.'
            : message,
        ),
        400,
      );
    }
  });
}
