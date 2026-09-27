import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../../test/helpers.ts';
import { makeInboxItem, makeP6Session, ownedLive, p6Context } from '../../../test/p6-fakes.ts';
import { remoteGuard } from '../../http/remote-guard.ts';
import { registerSessionActionRoutes } from '../../http/routes/session-actions.ts';
import type { OrcEnv } from '../../http/types.ts';
import { createDeviceService } from '../../remote/devices.ts';
import { createStepUpStore } from '../../remote/step-up.ts';
import { ServiceError } from '../errors.ts';
import type { PlanApprovalService } from '../review/plan-approval.ts';
import { createSessionActions, DEFAULT_APPROVE_TEXT, inboxSessionPk } from './session-actions.ts';

const REMOTE = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'tailscale-user-login': 'me@example.com',
  'content-type': 'application/json',
};
type Err = { error: { code: string } };

describe('inboxSessionPk', () => {
  it('prefers the payload, then the dedupe key, then sessionId', () => {
    expect(inboxSessionPk(makeInboxItem({ id: 'a' }))).toBe('claude:s1');
    expect(inboxSessionPk(makeInboxItem({ id: 'b', payload: {}, dedupeKey: 'plan:codex:c9' }))).toBe(
      'codex:c9',
    );
    expect(
      inboxSessionPk(
        makeInboxItem({ id: 'c', payload: {}, dedupeKey: 'pr:org/repo#1:checks', sessionId: 'x1' }),
      ),
    ).toBe('claude:x1');
    expect(
      inboxSessionPk(makeInboxItem({ id: 'd', payload: {}, dedupeKey: 'budget:global', sessionId: null })),
    ).toBeNull();
  });
});

describe('session actions', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { owned?: boolean; plans?: boolean } = {}) {
    const session = makeP6Session({
      id: 's1',
      live: o.owned === false ? { ...ownedLive(), ownership: 'observed', ptyId: null } : ownedLive('pty-1'),
    });
    const items = [
      makeInboxItem({
        id: 'plan1',
        kind: 'plan_approval',
        dedupeKey: 'plan:claude:s1',
        payload: { source: 'claude', id: 's1', approveText: 'yes, go' },
      }),
      makeInboxItem({ id: 'wait1' }),
      makeInboxItem({ id: 'auto1', kind: 'automation_result', dedupeKey: 'automation:r1', payload: {} }),
    ];
    const env = p6Context({
      sessions: [session],
      inbox: items,
      config: {
        remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' },
      },
    });
    cleanups.push(() => env.ctx.dispose());
    const approve = vi.fn(async () => {});
    if (o.plans) env.ctx.plans = { approve, reject: vi.fn(async () => {}) } as unknown as PlanApprovalService;
    const devices = createDeviceService(env.ctx.db);
    const stepUp = createStepUpStore({ ttlMs: () => 300_000 });
    const { device, token } = devices.create('Phone', 'me@example.com');
    const app = new Hono<OrcEnv>();
    app.onError((err, c) =>
      err instanceof ServiceError
        ? c.json(apiError(err.code, err.message), err.status)
        : c.json(apiError('internal', String(err)), 500),
    );
    app.use('*', remoteGuard({ config: env.ctx.config, devices, stepUp, funnel: { detected: () => false } }));
    const actions = createSessionActions(env.ctx);
    registerSessionActionRoutes(app, env.ctx, { actions });
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      app.request(`http://127.0.0.1:4317${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const local = { host: '127.0.0.1:4317', 'content-type': 'application/json' };
    const remote = { ...REMOTE, 'x-orc-token': token };
    return { ...env, approve, actions, post, local, remote, grant: () => stepUp.grant(device.id) };
  }

  it('sends a local reply to an owned session and audits it as the user', async () => {
    const b = build();
    expect(
      (await b.post('/api/sessions/claude/s1/reply', { text: 'yes, run the tests' }, b.local)).status,
    ).toBe(200);
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, run the tests' }]);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'user', result: 'ok' });
  });

  it('requires step-up for remote replies and audits them as remote', async () => {
    const b = build();
    const denied = await b.post('/api/sessions/claude/s1/reply', { text: 'continue' }, b.remote);
    expect(((await denied.json()) as Err).error.code).toBe('step_up_required');
    expect(b.rawPty.sent).toEqual([]);
    b.grant();
    expect((await b.post('/api/sessions/claude/s1/reply', { text: 'continue' }, b.remote)).status).toBe(200);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({
      actor: 'remote',
      actorDetail: 'Phone (me@example.com)',
    });
  });

  it('refuses sessions the app does not own', async () => {
    const b = build({ owned: false });
    const res = await b.post('/api/sessions/claude/s1/reply', { text: 'hi' }, b.local);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Err).error.code).toBe('not_owned');
  });

  it('blocks deny-listed remote input and audits the denial', async () => {
    const b = build();
    b.grant();
    const res = await b.post('/api/sessions/claude/s1/reply', { text: 'now run terraform apply' }, b.remote);
    expect(((await res.json()) as Err).error.code).toBe('denied');
    expect(b.rawPty.sent).toEqual([]);
    expect(b.audit.list({ action: 'pty.input' })[0]).toMatchObject({ actor: 'remote', result: 'denied' });
  });

  it('approves a plan through P4 when available, remotely with step-up', async () => {
    const b = build({ plans: true });
    b.grant();
    const res = await b.post('/api/inbox/plan1/approve', { confirm: true }, b.remote);
    expect(res.status).toBe(200);
    expect(b.approve).toHaveBeenCalledWith('claude:s1');
    expect(b.inbox.items.find((i) => i.id === 'plan1')?.state).toBe('done');
    expect(b.audit.list({ action: 'remote.approve' })[0]).toMatchObject({
      actor: 'remote',
      target: 'plan1',
      result: 'ok',
    });
  });

  it('falls back to sending the approve text and handles other kinds', async () => {
    const b = build();
    expect((await b.post('/api/inbox/plan1/approve', {}, b.local)).status).toBe(409);
    expect((await b.post('/api/inbox/plan1/approve', { confirm: true }, b.local)).status).toBe(200);
    expect(b.rawPty.sent).toEqual([{ id: 'pty-1', text: 'yes, go' }]);
    expect((await b.post('/api/inbox/auto1/approve', { confirm: true }, b.local)).status).toBe(200);
    const wait = await b.post('/api/inbox/wait1/approve', { confirm: true }, b.local);
    expect(((await wait.json()) as Err).error.code).toBe('not_approvable');
    expect(
      b.audit
        .list({ action: 'inbox.approve' })
        .map((e) => e.result)
        .sort(),
    ).toEqual(['error', 'ok', 'ok']);
    expect(DEFAULT_APPROVE_TEXT).toContain('proceed');
  });
});
