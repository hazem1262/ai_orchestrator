import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ArchiveStatus } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { type ArchiveServiceRuntime, createArchiveService } from '../../services/archive/archive.ts';
import { createApp } from '../app.ts';
import { registerArchiveRoutes } from './archive.ts';

const SECRET = 'hunter2';
const homes = useTempHomes();
let ctx: TestContext;
let archive: ArchiveServiceRuntime;
let app: Hono;
const proj = () => join(homes.claudeHome, 'projects/-Users-test-Wakecap');
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
type ErrBody = { error: { code: string; message: string; details?: unknown } };

beforeEach(() => {
  ctx = createTestContext({ homes });
  archive = createArchiveService(ctx, { codec: 'gzip' });
  ctx.archive = archive;
  app = new Hono();
  registerArchiveRoutes(app, ctx);
});

afterEach(() => {
  archive.stop();
  ctx.dispose();
});

describe('/api/archive', () => {
  it('syncs and reports status with the recommended snippet', async () => {
    const sync = await post('/api/archive/sync', {});
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ copied: 9 });
    const res = await app.request('/api/archive/status');
    expect(res.status).toBe(200);
    const status = ArchiveStatus.parse(await res.json());
    expect(status).toMatchObject({ enabled: true, files: 9, codec: 'gzip', cleanupPeriodDays: null });
    expect(status.recommendedSnippet).toContain('"cleanupPeriodDays"');
  });

  it('requires confirmation, restores, then refuses to overwrite', async () => {
    await post('/api/archive/sync', {});
    const target = join(proj(), 's-basic.jsonl');
    rmSync(target);

    const ask = await post('/api/archive/restore', { source: 'claude', id: 's-basic' });
    expect(ask.status).toBe(409);
    const askBody = (await ask.json()) as ErrBody & {
      error: { details: { summary: string; targets: string[] } };
    };
    expect(askBody.error.code).toBe('confirmation_required');
    expect(askBody.error.details.targets).toEqual([target]);
    expect(askBody.error.details.summary).toContain('Restore 1 transcript file');
    expect(existsSync(target)).toBe(false);

    const unconfirmed = await post('/api/archive/restore', {
      source: 'claude',
      id: 's-basic',
      confirm: false,
    });
    expect(unconfirmed.status).toBe(409);
    expect(existsSync(target)).toBe(false);

    const ok = await post('/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ restored: [target] });
    expect(existsSync(target)).toBe(true);

    const again = await post('/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrBody).error.code).toBe('restore_target_exists');
  });

  it('maps validation and plan errors', async () => {
    await post('/api/archive/sync', {});
    const missingId = await post('/api/archive/restore', { source: 'claude' });
    expect(missingId.status).toBe(400);
    expect(((await missingId.json()) as ErrBody).error.code).toBe('validation_failed');

    const notJson = await post('/api/archive/restore', '{not json');
    expect(notJson.status).toBe(400);

    const codex = await post('/api/archive/restore', { source: 'codex', id: 'x', confirm: true });
    expect(codex.status).toBe(400);
    expect(((await codex.json()) as ErrBody).error.code).toBe('unsupported_source');

    const unknown = await post('/api/archive/restore', { source: 'claude', id: 'nope' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrBody).error.code).toBe('not_archived');
  });

  it('answers 503 archive_unavailable when the archive service is not wired', async () => {
    ctx.archive = undefined;
    for (const res of [
      await app.request('/api/archive/status'),
      await post('/api/archive/sync', {}),
      await post('/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true }),
    ]) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrBody).error.code).toBe('archive_unavailable');
    }
  });
});

describe('secret redaction on the way out', () => {
  const secretDir = () => join(homes.claudeHome, `projects/-Users-test-PGPASSWORD=${SECRET}`);

  beforeEach(() => {
    mkdirSync(secretDir(), { recursive: true });
    cpSync(join(proj(), 's-basic.jsonl'), join(secretDir(), 's-secret.jsonl'));
  });

  it('redacts the confirmation targets and summary and the restored paths', async () => {
    await post('/api/archive/sync', {});
    rmSync(join(secretDir(), 's-secret.jsonl'));

    const ask = await post('/api/archive/restore', { source: 'claude', id: 's-secret' });
    expect(ask.status).toBe(409);
    const askText = await ask.text();
    expect(askText).toContain('confirmation_required');
    expect(askText).not.toContain(SECRET);

    const ok = await post('/api/archive/restore', { source: 'claude', id: 's-secret', confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(SECRET);
    expect(existsSync(join(secretDir(), 's-secret.jsonl'))).toBe(true);
  });

  it('redacts the refusal that lists existing paths', async () => {
    await post('/api/archive/sync', {});
    const again = await post('/api/archive/restore', { source: 'claude', id: 's-secret', confirm: true });
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).toContain('restore_target_exists');
    expect(text).not.toContain(SECRET);
  });

  it('redacts error bodies that echo the request', async () => {
    const unknown = await post('/api/archive/restore', { source: 'claude', id: `PGPASSWORD=${SECRET}` });
    expect(unknown.status).toBe(404);
    const unknownText = await unknown.text();
    expect(unknownText).toContain('not_archived');
    expect(unknownText).not.toContain(SECRET);

    const badKey = await post('/api/archive/restore', {
      source: 'claude',
      id: 's-basic',
      [`PGPASSWORD=${SECRET}`]: 1,
    });
    expect(badKey.status).toBe(400);
    const badKeyText = await badKey.text();
    expect(badKeyText).toContain('validation_failed');
    expect(badKeyText).not.toContain(SECRET);
  });
});

describe('authentication through the daemon app', () => {
  const base = 'http://127.0.0.1:4317';

  it('refuses every /api/archive route without the x-orc-token and serves them with it', async () => {
    const daemon = createApp({ ctx, token: 't', port: () => 4317, env: {} });
    const call = (method: string, path: string, headers: Record<string, string> = {}) =>
      daemon.request(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });

    for (const [method, path] of [
      ['GET', '/api/archive/status'],
      ['POST', '/api/archive/sync'],
      ['POST', '/api/archive/restore'],
    ] as const) {
      expect((await call(method, path)).status, `${method} ${path} without token`).toBe(401);
      expect(
        (await call(method, path, { 'x-orc-token': 'wrong' })).status,
        `${method} ${path} bad token`,
      ).toBe(401);
    }

    const status = await call('GET', '/api/archive/status', { 'x-orc-token': 't' });
    expect(status.status).toBe(200);
    expect(ArchiveStatus.parse(await status.json()).codec).toBe('gzip');
    const sync = await call('POST', '/api/archive/sync', { 'x-orc-token': 't' });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ copied: 9 });
  });
});
