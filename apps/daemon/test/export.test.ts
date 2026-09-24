import type { Handoff } from '@orc/core';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSessionExport, ExportTooLargeError } from '../src/services/export/export-zip.ts';
import { createLinksService } from '../src/services/links/links.ts';
import { createPlanFinderFromContext } from '../src/services/links/plans.ts';
import { createSessionDetailService } from '../src/services/session-detail/detail.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';

let t: P3Harness;
beforeAll(async () => {
  t = await createP3Harness();
});
afterAll(async () => {
  await t.cleanup();
});

function deps(
  extra: { handoffs?: { latest(pk: string): Handoff | null; toMarkdown(h: Handoff): string } } = {},
) {
  const audit = t.ctx.audit;
  if (!audit) throw new Error('audit missing');
  return {
    sessions: t.ctx.sessions,
    detail: createSessionDetailService(t.ctx),
    links: createLinksService(t.ctx, createPlanFinderFromContext(t.ctx)),
    audit,
    version: '0.0.0',
    now: () => new Date('2026-09-17T12:00:00Z'),
    ...extra,
  };
}

describe('buildSessionExport', () => {
  it('bundles transcript, subagents and derived data', async () => {
    const r = await buildSessionExport(deps(), 'claude', 's-subagents', { redact: true });
    if (!r) throw new Error('expected export');
    const files = unzipSync(r.bytes);
    expect(Object.keys(files).sort()).toEqual([
      'agents.json',
      'audit.json',
      'deliverables.json',
      'files.json',
      'links.json',
      'manifest.json',
      'session.json',
      'stats.json',
      'subagents/agent-ag1.jsonl',
      'subagents/agent-ag1.meta.json',
      'subagents/agent-ag2.jsonl',
      'subagents/agent-ag2.meta.json',
      'subagents/agent-ag3.jsonl',
      'subagents/agent-ag3.meta.json',
      'transcript.jsonl',
    ]);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as {
      redacted: boolean;
      exportedAt: string;
      files: string[];
    };
    expect(manifest).toMatchObject({ redacted: true, exportedAt: '2026-09-17T12:00:00.000Z' });
    expect(manifest.files).toContain('transcript.jsonl');
    expect(r.filename).toBe('claude-s-subagents.zip');
  });

  it('includes a redacted handoff when a handoff service is present', async () => {
    const handoff: Handoff = {
      id: 'h1',
      sessionId: 's-basic',
      status: 'done',
      summary: 's',
      evidence: [],
      files: [],
      nextSteps: [],
      blockers: [],
      links: [],
      createdAt: '2026-09-17T00:00:00Z',
    };
    const r = await buildSessionExport(
      deps({ handoffs: { latest: () => handoff, toMarkdown: () => '# Handoff\nPGPASSWORD=hunter2' } }),
      'claude',
      's-basic',
      { redact: true },
    );
    const files = unzipSync(r?.bytes ?? new Uint8Array());
    expect(strFromU8(files['handoff.md'] ?? new Uint8Array())).toBe(
      '# Handoff\nPGPASSWORD=«redacted:secret»',
    );
    expect(files['recap.md']).toBeUndefined();
  });

  it('returns null for unknown sessions and enforces the size cap', async () => {
    expect(await buildSessionExport(deps(), 'claude', 'nope', { redact: true })).toBeNull();
    await expect(
      buildSessionExport(deps(), 'claude', 's-basic', { redact: true, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});

describe('GET /api/sessions/:source/:id/export', () => {
  const req = (query = '') => t.request(`/api/sessions/claude/s-drift/export${query}`);

  it('is redacted by default', async () => {
    const res = await req();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="claude-s-drift.zip"');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const transcript = strFromU8(files['transcript.jsonl'] ?? new Uint8Array());
    expect(transcript).toContain('«redacted:secret»');
    expect(transcript).not.toContain('hunter2');
  });

  it('requires confirmation for an unredacted export, and audits both exports', async () => {
    const unconfirmed = await req('?redact=false');
    expect(unconfirmed.status).toBe(409);
    const body = (await unconfirmed.json()) as { error: { code: string; details: { summary: string } } };
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.details.summary).toContain('WITHOUT redaction');

    const confirmed = await req('?redact=false&confirm=true');
    expect(confirmed.status).toBe(200);
    const files = unzipSync(new Uint8Array(await confirmed.arrayBuffer()));
    expect(strFromU8(files['transcript.jsonl'] ?? new Uint8Array())).toContain('hunter2');

    const exports = t.ctx.audit?.list({ action: 'session.export', sessionPk: 'claude:s-drift' }) ?? [];
    expect(exports.map((e) => e.params.redact ?? 'true')).toEqual(['false', 'true']);
  });

  it('404s for unknown sessions', async () => {
    const res = await t.request('/api/sessions/claude/nope/export');
    expect(res.status).toBe(404);
  });
});
