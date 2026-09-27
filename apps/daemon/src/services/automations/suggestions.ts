import { dirname, join } from 'node:path';
import { LaunchRequest, type Suggestion } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/suggestions.ts';
import { ServiceError } from '../errors.ts';
import { addedLinesDiff, defaultBranch } from '../git/git-info.ts';
import { sessionPk } from '../sessions.ts';

export interface SuggestionService {
  list(state?: Suggestion['state']): Suggestion[];
  refresh(): Promise<{ added: number }>;
  accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>;
  dismiss(id: string): Suggestion;
  start(): () => void;
}

export interface SuggestionDeps {
  ctx: DaemonContext;
  now?: () => Date;
  addedLines?: (cwd: string, base: string) => Promise<string>;
}

export interface NewTodo {
  file: string;
  line: number;
  kind: 'TODO' | 'FIXME';
  text: string;
}

export const BACKLOG_STATES: ReadonlySet<string> = new Set(['backlog', 'todo', 'triage', 'unstarted']);

const MARKER = /\b(TODO|FIXME)\b(?:\([^)]*\))?[:\s-]*(.*)$/;

export function parseNewTodos(diff: string): NewTodo[] {
  const out: NewTodo[] = [];
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      const m = MARKER.exec(raw.slice(1));
      if (m?.[1]) out.push({ file, line, kind: m[1] as NewTodo['kind'], text: (m[2] ?? '').trim() });
      line++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line++;
    }
  }
  return out;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function createSuggestionService(deps: SuggestionDeps): SuggestionService {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const addedLines = deps.addedLines ?? addedLinesDiff;

  const projectForTicket = (ticket: string): string | null => {
    for (const p of ctx.config().projects) {
      if (p.ticketRegex && new RegExp(p.ticketRegex).test(ticket)) return p.id;
    }
    return ctx.config().defaultProjectId;
  };

  async function collectLinear(): Promise<number> {
    if (!ctx.linear) return 0;
    let added = 0;
    try {
      for (const i of await ctx.linear.assignedToMe()) {
        if (!BACKLOG_STATES.has(i.state.toLowerCase())) continue;
        const row = repo.insertSuggestion(
          ctx.db,
          {
            source: 'linear',
            projectId: projectForTicket(i.identifier),
            title: `${i.identifier}: ${i.title}`,
            detail: i.url,
            ticket: i.identifier,
            file: null,
            line: null,
            dedupeKey: `linear:${i.identifier}`,
          },
          now().toISOString(),
        );
        if (row) added++;
      }
    } catch (err) {
      ctx.log.warn({ err }, 'suggestions: linear backlog failed');
    }
    return added;
  }

  async function collectTodos(): Promise<number> {
    if (!ctx.worktrees) return 0;
    let added = 0;
    for (const wt of ctx.worktrees.list({ state: 'active' })) {
      if (!wt.createdByApp) continue;
      try {
        const base = wt.base ?? (await defaultBranch(wt.repo));
        for (const t of parseNewTodos(await addedLines(wt.path, base))) {
          const row = repo.insertSuggestion(
            ctx.db,
            {
              source: 'todo',
              projectId: wt.projectId,
              title: `${t.kind}: ${t.text}`,
              detail: `${wt.branch} · ${t.file}:${t.line}`,
              ticket: wt.ticket,
              file: join(wt.path, t.file),
              line: t.line,
              dedupeKey: `todo:${wt.repo}:${t.file}:${normalise(t.text)}`,
            },
            now().toISOString(),
          );
          if (row) added++;
        }
      } catch (err) {
        ctx.log.warn({ err, worktree: wt.path }, 'suggestions: todo scan failed');
      }
    }
    return added;
  }

  // Ids whose launch is in flight: a second accept (or a dismiss) during the await must not launch twice.
  const accepting = new Set<string>();

  function mustBeNew(id: string): Suggestion {
    const s = repo.getSuggestion(ctx.db, id);
    if (!s) throw new ServiceError('not_found', 404, `suggestion ${id} not found`);
    if (accepting.has(id)) throw new ServiceError('invalid_state', 409, `suggestion ${id} is being accepted`);
    if (s.state !== 'new')
      throw new ServiceError('invalid_state', 409, `suggestion ${id} is already ${s.state}`);
    return s;
  }

  function launchRequestFor(s: Suggestion): LaunchRequest {
    const projectId = s.projectId ?? ctx.config().defaultProjectId;
    if (s.source === 'linear') {
      const project = ctx.projects.get(projectId);
      const cwd = project?.pathPrefixes[0];
      if (!cwd) throw new ServiceError('validation_failed', 400, `project ${projectId} has no path`);
      const template = ctx.templates
        ?.list(projectId)
        .find((t) => t.id === 'implement-ticket' || t.label.toLowerCase() === 'implement ticket');
      const vars = { ticket: s.ticket ?? '', ticketUrl: s.detail };
      return LaunchRequest.parse({
        source: 'claude',
        projectId,
        cwd,
        prompt: template ? '' : `Implement ${s.title}. Ticket: ${s.detail}`,
        templateId: template?.id,
        vars,
        ticket: s.ticket ?? undefined,
      });
    }
    const file = s.file ?? '';
    const cwd = ctx.worktrees?.findByCwd(file)?.path ?? dirname(file);
    return LaunchRequest.parse({
      source: 'claude',
      projectId,
      cwd,
      prompt: `Resolve this ${s.title} at ${file}:${s.line ?? 1}. Keep the change small and add a test if behaviour changes.`,
      vars: {},
      ticket: s.ticket ?? undefined,
    });
  }

  const svc: SuggestionService = {
    list: (state) => repo.listSuggestions(ctx.db, state),
    async refresh() {
      const added = (await collectLinear()) + (await collectTodos());
      return { added };
    },
    async accept(id) {
      const s = mustBeNew(id);
      const req = launchRequestFor(s);
      const launcher = ctx.launcher;
      if (!launcher) throw new ServiceError('not_enabled', 409, 'launch service is not running');
      accepting.add(id);
      let res: Awaited<ReturnType<typeof launcher.launch>>;
      try {
        res = await launcher.launch(req);
        repo.decideSuggestion(ctx.db, id, 'accepted', now().toISOString(), res.ptyId);
      } finally {
        accepting.delete(id);
      }
      ctx.audit.record({
        actor: 'user',
        actorDetail: null,
        action: 'session.launch',
        target: res.sessionId ? sessionPk('claude', res.sessionId) : `pty:${res.ptyId}`,
        params: { suggestionId: id, source: s.source, cwd: req.cwd, ticket: s.ticket },
        result: 'ok',
        error: null,
      });
      return { ptyId: res.ptyId, sessionPk: res.sessionId ? sessionPk('claude', res.sessionId) : null };
    },
    dismiss(id) {
      mustBeNew(id);
      return repo.decideSuggestion(ctx.db, id, 'dismissed', now().toISOString());
    },
    start() {
      const cfg = ctx.config().automations.suggestions;
      if (!cfg.enabled) return () => {};
      const run = () =>
        void svc.refresh().catch((err: unknown) => ctx.log.warn({ err }, 'suggestions refresh failed'));
      run();
      const timer = setInterval(run, cfg.intervalMin * 60_000);
      return () => clearInterval(timer);
    },
  };
  return svc;
}
