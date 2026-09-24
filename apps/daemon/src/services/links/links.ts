import type { SessionLinks } from '@orc/api-contract';
import { parseJsonLine, readJsonlFrom, type Source } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { PlanFinder } from './plans.ts';

export interface LinksService {
  forSession(source: Source, id: string): Promise<SessionLinks | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function scanTranscriptMeta(
  path: string | null,
): Promise<{ artifacts: SessionLinks['artifacts']; bridgeSessionId: string | null }> {
  const empty = { artifacts: [], bridgeSessionId: null };
  if (!path?.endsWith('.jsonl')) return empty;
  const r = await readJsonlFrom(path, 0).catch(() => null);
  if (!r) return empty;
  const artifacts = new Map<string, SessionLinks['artifacts'][number]>();
  let bridgeSessionId: string | null = null;
  for (const l of r.lines) {
    if (!l.text.includes('"frame-link"') && !l.text.includes('"bridge-session"')) continue;
    const v = parseJsonLine(l.text);
    if (!isObj(v)) continue;
    if (v.type === 'frame-link') {
      const a = { title: str(v.title), url: str(v.frameUrl), path: str(v.path) };
      artifacts.set(`${a.url ?? ''}|${a.path ?? ''}`, a);
    } else if (v.type === 'bridge-session') {
      bridgeSessionId = str(v.bridgeSessionId) ?? bridgeSessionId;
    }
  }
  return { artifacts: [...artifacts.values()], bridgeSessionId };
}

export function createLinksService(
  ctx: Pick<DaemonContext, 'sessions' | 'config'>,
  finder: PlanFinder,
): LinksService {
  return {
    async forSession(source, id) {
      const s = ctx.sessions.get(source, id);
      if (!s) return null;
      const ws = ctx.config().links.linearWorkspace;
      const meta = await scanTranscriptMeta(s.transcriptPath);
      return {
        prs: s.prs,
        tickets: s.tickets.map((t) => ({ id: t, url: ws ? `https://linear.app/${ws}/issue/${t}` : null })),
        plans: await finder.forSession(s),
        artifacts: meta.artifacts,
        bridgeSessionId: meta.bridgeSessionId,
      };
    },
  };
}
