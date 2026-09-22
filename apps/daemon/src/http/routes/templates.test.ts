import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { BUILTIN_TEMPLATES, createTemplateRegistry, type Template } from '../../services/templates.ts';
import { registerTemplateRoutes } from './templates.ts';

const homes = useTempHomes();
let ctx: TestContext;
let app: Hono;

const forzaOnly: Template = {
  id: 'forza-only',
  kind: 'preset',
  label: 'Forza',
  prompt: 'x',
  vars: [],
  defaultSource: 'codex',
  projectIds: ['forza'],
};

const getList = async (qs = '') => {
  const res = await app.request(`/api/templates${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Template[];
};

beforeEach(() => {
  ctx = createTestContext({ homes });
  ctx.templates = createTemplateRegistry({ extra: [forzaOnly] });
  app = new Hono();
  registerTemplateRoutes(app, ctx);
});

afterEach(() => {
  ctx.dispose();
});

describe('GET /api/templates', () => {
  it('returns the templates for a project', async () => {
    const body = await getList('?projectId=wakecap');
    expect(body.map((t) => t.id)).toContain('wf-implement-ticket');
    expect(body).toHaveLength(10);
  });

  it('returns full template objects', async () => {
    const body = await getList('?projectId=wakecap');
    expect(body.find((t) => t.id === 'wf-implement-ticket')).toEqual({
      id: 'wf-implement-ticket',
      kind: 'workflow',
      label: 'Implement ticket',
      prompt: '/conductor {{ticketUrl}}',
      vars: ['ticketUrl'],
      defaultSource: 'claude',
      projectIds: 'all',
    });
  });

  it('includes a project-scoped template only for its project', async () => {
    expect((await getList('?projectId=forza')).map((t) => t.id)).toEqual([
      ...BUILTIN_TEMPLATES.map((t) => t.id),
      'forza-only',
    ]);
    expect((await getList('?projectId=wakecap')).some((t) => t.id === 'forza-only')).toBe(false);
  });

  it('returns every template without a projectId or with an empty one', async () => {
    expect(await getList()).toHaveLength(11);
    expect(await getList('?projectId=')).toHaveLength(11);
  });

  it('returns an empty list when no registry is wired', async () => {
    const bare = createTestContext({ homes });
    const bareApp = new Hono();
    registerTemplateRoutes(bareApp, bare);
    try {
      const res = await bareApp.request('/api/templates');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      bare.dispose();
    }
  });
});
