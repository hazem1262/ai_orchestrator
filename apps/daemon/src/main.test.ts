import { describe, expect, it } from 'vitest';
import { createHealthApp } from './main.ts';

describe('health', () => {
  it('returns ok', async () => {
    const res = await createHealthApp().request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.0.0');
  });
});
