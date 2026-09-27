import { randomUUID } from 'node:crypto';
import { LaunchRequest } from '@orc/api-contract';
import {
  approxTokens,
  buildRecapDigest,
  buildResumePrompt,
  collectHandoffEvidence,
  DEFAULT_HANDOFF_PROMPT,
  type Handoff,
  type HandoffLlmFields,
  handoffToMarkdown,
  parseHandoffJson,
  redact,
  renderPromptTemplate,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getHandoff, insertHandoff, latestHandoff } from '../../db/repos/handoffs.ts';
import { ServiceError } from '../errors.ts';
import { need } from '../need.ts';
import { type RecapService, transcriptOffset } from '../recap/recap.ts';
import { loadEvents } from '../session-pages.ts';

export interface HandoffService {
  generate(sessionPk: string): Promise<Handoff>;
  toMarkdown(h: Handoff): string;
  latest(sessionPk: string): Handoff | null;
  get(id: string): Handoff | null;
  resumeFresh(handoffId: string): Promise<{ ptyId: string }>;
}

export function createHandoffService(
  ctx: DaemonContext,
  deps: { recaps: RecapService; now?: () => Date },
): HandoffService {
  const now = deps.now ?? (() => new Date());

  async function llmFields(pk: string, prompt: string, offset: number): Promise<HandoffLlmFields | null> {
    try {
      const rec =
        deps.recaps.findCached('handoff', pk, offset) ??
        (await deps.recaps.runLlm('handoff', pk, offset, prompt, {
          onDemand: true,
          approxTokens: approxTokens(prompt),
        }));
      return parseHandoffJson(rec.text);
    } catch (err) {
      const code = err instanceof ServiceError ? err.code : 'error';
      ctx.log.info({ pk, code }, 'handoff LLM step skipped');
      return null;
    }
  }

  return {
    async generate(pk) {
      const s = ctx.sessions.getByPk(pk);
      if (!s) throw new ServiceError('not_found', 404, 'session not found');
      const cfg = ctx.config().recaps;
      const events = loadEvents(ctx, s, null);
      const structured = collectHandoffEvidence(s, events);
      const project = s.projectId ? ctx.projects.get(s.projectId) : null;
      const llmAllowed =
        (project?.features.recaps ?? true) && !(s.projectId && cfg.excludeProjectIds.includes(s.projectId));
      let llm: HandoffLlmFields | null = null;
      if (llmAllowed) {
        const digest = buildRecapDigest({
          session: s,
          events,
          tests: s.lastTest ? [s.lastTest] : [],
          plans: [],
          maxInputTokens: cfg.maxInputTokens,
        });
        const prompt = renderPromptTemplate(DEFAULT_HANDOFF_PROMPT, {
          language: cfg.language,
          digest: digest.text,
          evidence: structured.evidence.join('\n') || 'none',
        });
        llm = await llmFields(pk, prompt, transcriptOffset(s));
      }
      const goal = ctx.goals?.get('session', pk) ?? null;
      const h: Handoff = {
        id: randomUUID(),
        sessionId: pk,
        status: llm?.status ?? goal?.state ?? s.live?.status ?? 'unknown',
        // Model output can echo digest text, so the free-text fields are redacted again.
        summary: redact(llm?.summary ?? s.recap ?? s.awaySummary ?? s.lastPrompt ?? ''),
        evidence: structured.evidence,
        files: structured.files,
        nextSteps: (llm?.nextSteps ?? []).map((x) => redact(x)),
        blockers: (llm?.blockers ?? (goal?.blockedReason ? [goal.blockedReason] : [])).map((x) => redact(x)),
        links: structured.links,
        createdAt: now().toISOString(),
      };
      insertHandoff(ctx.db, h);
      return h;
    },
    toMarkdown: handoffToMarkdown,
    latest: (pk) => latestHandoff(ctx.db, pk),
    get: (id) => getHandoff(ctx.db, id),
    async resumeFresh(id) {
      const h = getHandoff(ctx.db, id);
      if (!h) throw new ServiceError('not_found', 404, 'handoff not found');
      const s = ctx.sessions.getByPk(h.sessionId);
      if (!s) throw new ServiceError('not_found', 404, 'session not found');
      const res = await need(ctx.launcher, 'launcher').launch(
        LaunchRequest.parse({
          source: s.source === 'codex' ? 'codex' : 'claude',
          projectId: s.projectId,
          cwd: s.startCwd,
          prompt: buildResumePrompt(h),
          ticket: s.tickets[0],
        }),
      );
      return { ptyId: res.ptyId };
    },
  };
}
