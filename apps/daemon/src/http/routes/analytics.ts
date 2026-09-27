import {
  AnalyticsBucketQuery,
  AnalyticsCostQuery,
  AnalyticsRangeQuery,
  AnalyticsTopQuery,
  DigestGenerateBody,
} from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { resolveRange } from '../../services/analytics/analytics.ts';
import { need } from '../../services/need.ts';
import { readBody, readQuery } from '../p5-util.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

export function registerAnalyticsRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.analytics, 'analytics');
  const digests = () => need(ctx.digests, 'digests');
  const now = () => new Date();

  // Ticket keys, session names, tool/skill names, facet keys, wstack skill names and the digest
  // markdown (PR titles, session names) all come from transcripts or their neighbours, so every
  // body that can carry them goes out through redactedJson. Timing is numbers and dates only.
  app.get('/api/analytics/cost', (c) => {
    const q = readQuery(c, AnalyticsCostQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().cost({ ...resolveRange(q.data, now()), groupBy: q.data.groupBy }));
  });
  app.get('/api/analytics/top', (c) => {
    const q = readQuery(c, AnalyticsTopQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().top({ ...resolveRange(q.data, now()), limit: q.data.limit }));
  });
  app.get('/api/analytics/tools', (c) => {
    const q = readQuery(c, AnalyticsBucketQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().tools({ ...resolveRange(q.data, now()), bucket: q.data.bucket }));
  });
  app.get('/api/analytics/timing', (c) => {
    const q = readQuery(c, AnalyticsBucketQuery);
    if (!q.ok) return q.res;
    return c.json(svc().timing({ ...resolveRange(q.data, now()), bucket: q.data.bucket }));
  });
  app.get('/api/analytics/outcomes', (c) => {
    const q = readQuery(c, AnalyticsRangeQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().outcomes(resolveRange(q.data, now())));
  });
  app.get('/api/analytics/wstack', (c) => {
    const q = readQuery(c, AnalyticsRangeQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().wstack(resolveRange(q.data, now())));
  });
  app.get('/api/analytics/digest', (c) => redactedJson(c, digests().latest()));
  app.post('/api/analytics/digest', async (c) => {
    const b = await readBody(c, DigestGenerateBody);
    if (!b.ok) return b.res;
    return redactedJson(c, await digests().generate(b.data.weekStart));
  });
}
