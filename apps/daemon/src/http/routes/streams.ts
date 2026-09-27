import { StreamLinkBody, StreamsListQuery } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { notFound, readBody, readQuery } from '../p5-util.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

export function registerStreamRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.streams, 'streams');

  // Stream titles and timeline details come from session names, prompts and recaps
  // (transcript-derived), so every body that carries them goes out through redactedJson.
  app.get('/api/streams', async (c) => {
    const q = readQuery(c, StreamsListQuery);
    if (!q.ok) return q.res;
    await svc().refreshIfStale();
    return redactedJson(c, svc().list(q.data));
  });
  app.post('/api/streams/refresh', async (c) => redactedJson(c, await svc().refresh()));
  app.get('/api/streams/:ticket', async (c) => {
    const d = await svc().get(c.req.param('ticket'));
    return d ? redactedJson(c, d) : notFound(c, 'stream');
  });
  app.post('/api/streams/:ticket/link', async (c) => {
    const b = await readBody(c, StreamLinkBody);
    if (!b.ok) return b.res;
    return c.json(svc().link(c.req.param('ticket'), b.data.kind, b.data.ref));
  });
  app.post('/api/streams/:ticket/unlink', async (c) => {
    const b = await readBody(c, StreamLinkBody);
    if (!b.ok) return b.res;
    return c.json(svc().unlink(c.req.param('ticket'), b.data.kind, b.data.ref));
  });
}
