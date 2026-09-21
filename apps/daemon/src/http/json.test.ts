import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseWith, readJson } from './json.ts';

describe('parseWith', () => {
  it('names the offending field in the message and keeps the raw issues as details', () => {
    const schema = z.object({ limit: z.number().max(100) });
    expect.assertions(3);
    try {
      parseWith(schema, { limit: 9999 });
    } catch (e) {
      expect(e).toMatchObject({ code: 'validation_failed', status: 400 });
      expect((e as Error).message).toContain('limit');
      expect((e as { details?: unknown }).details).toBeInstanceOf(Array);
    }
  });
});

describe('readJson', () => {
  const schema = z.strictObject({ pathPrefixes: z.array(z.string().startsWith('/')).min(1) });

  async function post(body: unknown) {
    const app = new Hono();
    app.post('/x', async (c) => c.json(await readJson(c, schema)));
    app.onError((err, c) => {
      const e = err as { status?: number; code?: string; message: string };
      return c.json({ error: { code: e.code, message: e.message } }, (e.status as 400 | 422) ?? 500);
    });
    return app.request('http://x/x', { method: 'POST', body: JSON.stringify(body) });
  }

  it('names the field path in a 400 for a non-absolute path prefix', async () => {
    const res = await post({ pathPrefixes: ['relative/path'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toContain('pathPrefixes.0');
  });

  it('still returns 422 validation_failed for an unrecognised key', async () => {
    const res = await post({ pathPrefixes: ['/ok'], extra: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toContain('extra');
  });

  it('rejects a body that is not JSON with a 400', async () => {
    const app = new Hono();
    app.post('/x', async (c) => c.json(await readJson(c, schema)));
    app.onError((err, c) => {
      const e = err as { status?: number; code?: string; message: string };
      return c.json({ error: { code: e.code, message: e.message } }, (e.status as 400) ?? 500);
    });
    const res = await app.request('http://x/x', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});
