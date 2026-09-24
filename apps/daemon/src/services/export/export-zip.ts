import { readFile } from 'node:fs/promises';
import { type Handoff, redact, redactDeep, type Source } from '@orc/core';
import { strToU8, type Zippable, zipSync } from 'fflate';
import type { AuditService } from '../audit/audit.ts';
import type { LinksService } from '../links/links.ts';
import type { SessionDetailService } from '../session-detail/detail.ts';
import type { SessionService } from '../sessions.ts';

export interface ExportDeps {
  sessions: Pick<SessionService, 'get' | 'agents'>;
  detail: SessionDetailService;
  links: LinksService;
  audit: AuditService;
  handoffs?: { latest(sessionPk: string): Handoff | null; toMarkdown(h: Handoff): string };
  version: string;
  now?: () => Date;
}

export interface ExportManifest {
  formatVersion: 1;
  sessionPk: string;
  source: Source;
  id: string;
  exportedAt: string;
  appVersion: string;
  redacted: boolean;
  files: string[];
  notes: string[];
}

export interface ExportResult {
  filename: string;
  bytes: Uint8Array;
  manifest: ExportManifest;
}

export class ExportTooLargeError extends Error {
  constructor(bytes: number, max: number) {
    super(`export would be ${bytes} bytes, above the ${max} byte limit`);
    this.name = 'ExportTooLargeError';
  }
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

async function readJsonl(path: string, doRedact: boolean): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  try {
    const text = await readFile(path, 'utf8');
    return doRedact
      ? text
          .split('\n')
          .map((l) => redact(l))
          .join('\n')
      : text;
  } catch {
    return null;
  }
}

export async function buildSessionExport(
  deps: ExportDeps,
  source: Source,
  id: string,
  opts: { redact: boolean; maxBytes?: number },
): Promise<ExportResult | null> {
  const session = deps.sessions.get(source, id);
  if (!session) return null;
  const pk = `${source}:${id}`;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = deps.now?.() ?? new Date();
  const clean = <T>(v: T): T => (opts.redact ? redactDeep(v) : v);
  const json = (v: unknown) => strToU8(`${JSON.stringify(clean(v), null, 2)}\n`);

  const files: Zippable = {};
  const notes: string[] = [];
  let total = 0;
  const add = (name: string, data: Uint8Array) => {
    total += data.byteLength;
    if (total > max) throw new ExportTooLargeError(total, max);
    files[name] = data;
  };

  add('session.json', json(session));

  const transcript = session.transcriptPath ? await readJsonl(session.transcriptPath, opts.redact) : null;
  if (transcript !== null) add('transcript.jsonl', strToU8(transcript));
  else {
    notes.push(
      session.transcriptPath
        ? 'transcript is archived or unreadable; restore it to include it'
        : 'no transcript on disk (prompts-only or remote session)',
    );
  }

  const agents = deps.sessions.agents(source, id);
  for (const a of agents) {
    const text = await readJsonl(a.transcriptPath, opts.redact);
    if (text !== null) add(`subagents/agent-${a.id}.jsonl`, strToU8(text));
    else notes.push(`subagent ${a.id} transcript unavailable`);
    const meta = await readFile(a.transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => null);
    if (meta !== null) add(`subagents/agent-${a.id}.meta.json`, strToU8(opts.redact ? redact(meta) : meta));
  }
  add('agents.json', json(agents));

  const stats = deps.detail.stats(source, id);
  if (stats) add('stats.json', json(stats));
  const deliverables = deps.detail.deliverables(source, id);
  if (deliverables) add('deliverables.json', json(deliverables));
  const fileSummaries = deps.detail.files(source, id);
  if (fileSummaries) add('files.json', json(fileSummaries));
  const links = await deps.links.forSession(source, id);
  if (links) add('links.json', json(links));
  add('audit.json', json(deps.audit.list({ sessionPk: pk, limit: 1000 })));

  if (session.recap) add('recap.md', strToU8(`${clean(session.recap)}\n`));
  const handoff = deps.handoffs?.latest(pk) ?? null;
  if (handoff && deps.handoffs) add('handoff.md', strToU8(clean(deps.handoffs.toMarkdown(handoff))));

  const manifest: ExportManifest = {
    formatVersion: 1,
    sessionPk: pk,
    source,
    id,
    exportedAt: now.toISOString(),
    appVersion: deps.version,
    redacted: opts.redact,
    files: [...Object.keys(files), 'manifest.json'].sort(),
    notes,
  };
  files['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

  return {
    filename: `${source}-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.zip`,
    bytes: zipSync(files, { level: 6, mtime: now }),
    manifest,
  };
}
