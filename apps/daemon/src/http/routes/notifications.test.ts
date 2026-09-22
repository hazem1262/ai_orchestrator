import { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { effectivePrefs, registerNotificationRoutes } from './notifications.ts';

type Prefs = Record<string, { enabled: boolean; channels: string[] }>;

const homes = useTempHomes();
let ctx: TestContext;
let app: Hono;
let cfg: OrcConfig;
let updates: number;

const put = (body: unknown) =>
  app.request('/api/config/notifications', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = async () => (await (await app.request('/api/config/notifications')).json()) as Prefs;
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  ctx = createTestContext({ homes });
  cfg = ctx.config();
  updates = 0;
  ctx.config = () => cfg;
  ctx.updateConfig = (fn) => {
    updates += 1;
    cfg = fn(cfg);
    return cfg;
  };
  app = new Hono();
  registerNotificationRoutes(app, ctx);
});

afterEach(() => {
  ctx.dispose();
});

describe('effectivePrefs', () => {
  it('turns on waiting, review, error, tests_red, plan_approval and blocked by default, via macOS', () => {
    const p = effectivePrefs(OrcConfig.parse({}));
    for (const k of ['waiting', 'review', 'error', 'tests_red', 'plan_approval', 'blocked']) {
      expect(p[k]).toEqual({ enabled: true, channels: ['macos'] });
    }
  });

  it('leaves every other kind off', () => {
    const p = effectivePrefs(OrcConfig.parse({}));
    for (const k of ['budget', 'automation_result', 'supervisor_escalation', 'pr_event', 'reminder']) {
      expect(p[k]?.enabled ?? false).toBe(false);
    }
  });

  it('lets config win over a default', () => {
    const p = effectivePrefs(
      OrcConfig.parse({
        notifications: {
          waiting: { enabled: false, channels: [] },
          reminder: { enabled: true, channels: ['webpush'] },
        },
      }),
    );
    expect(p.waiting).toEqual({ enabled: false, channels: [] });
    expect(p.reminder).toEqual({ enabled: true, channels: ['webpush'] });
    expect(p.review).toEqual({ enabled: true, channels: ['macos'] });
  });
});

describe('GET /api/config/notifications', () => {
  it('returns defaults merged with config', async () => {
    cfg = OrcConfig.parse({ ...cfg, notifications: { review: { enabled: false, channels: [] } } });
    const body = await get();
    expect(body.waiting).toEqual({ enabled: true, channels: ['macos'] });
    expect(body.tests_red?.enabled).toBe(true);
    expect(body.review).toEqual({ enabled: false, channels: [] });
  });
});

describe('PUT /api/config/notifications', () => {
  it('saves preferences through updateConfig and returns the effective prefs', async () => {
    const res = await put({
      waiting: { enabled: false, channels: [] },
      review: { enabled: true, channels: ['macos'] },
    });
    expect(res.status).toBe(200);
    expect(updates).toBe(1);
    expect(cfg.notifications.waiting).toEqual({ enabled: false, channels: [] });
    const body = (await res.json()) as Prefs;
    expect(body.waiting?.enabled).toBe(false);
    expect(body.error?.enabled).toBe(true);
    expect((await get()).waiting?.enabled).toBe(false);
  });

  it('rejects an unknown kind without saving', async () => {
    const res = await put({ sleeping: { enabled: true, channels: [] } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('validation_failed');
    expect(updates).toBe(0);
  });

  it('rejects an unknown channel without saving', async () => {
    const res = await put({ waiting: { enabled: true, channels: ['fax'] } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('validation_failed');
    expect(updates).toBe(0);
  });

  it('rejects a body that is not JSON without saving', async () => {
    const res = await put('{not json');
    expect(res.status).toBe(400);
    expect(updates).toBe(0);
  });

  it('answers 503 config_readonly when the context cannot update config', async () => {
    delete ctx.updateConfig;
    app = new Hono();
    registerNotificationRoutes(app, ctx);
    const res = await put({ waiting: { enabled: false, channels: [] } });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('config_readonly');
  });
});
