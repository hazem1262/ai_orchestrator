import type {
  LiveStatus,
  PrRef,
  StreamLink,
  StreamLinkKind,
  StreamPr,
  StreamStage,
  TicketSignal,
} from '../types/index.ts';

export const STREAM_TICKET_PATTERN = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';
export const STREAM_STAGES: readonly StreamStage[] = [
  'planned',
  'implementing',
  'in_review',
  'pr_open',
  'merged',
  'backmerged',
  'released',
];
export const REVIEW_SKILLS: readonly string[] = ['review', 'preflight', 'code-review'];
export const RELEASE_SKILLS: readonly string[] = ['releaseit'];

export function extractTicketsFrom(text: string | null | undefined, pattern: string | null): string[] {
  if (!text) return [];
  let re: RegExp;
  try {
    re = new RegExp(pattern ?? STREAM_TICKET_PATTERN, 'gi');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const t = m[0].toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const BACKMERGE_HEAD = /^backmerge[/_-]/i;
const BACKMERGE_TITLE = /\bback-?merge\b/i;
const UPPER_BRANCHES = new Set(['master', 'main', 'staging']);
const LOWER_BRANCHES = new Set(['staging', 'testing', 'develop']);

export function isBackmergePr(p: { title: string; headRef: string | null; baseRef: string | null }): boolean {
  if (p.headRef !== null && BACKMERGE_HEAD.test(p.headRef)) return true;
  if (BACKMERGE_TITLE.test(p.title)) return true;
  return (
    p.headRef !== null &&
    p.baseRef !== null &&
    p.headRef !== p.baseRef &&
    UPPER_BRANCHES.has(p.headRef) &&
    LOWER_BRANCHES.has(p.baseRef)
  );
}

const basename = (p: string) => p.split('/').pop() ?? p;

export function planTicket(path: string, pattern: string | null): string | null {
  const name = basename(path);
  const first = extractTicketsFrom(name, pattern)[0];
  return first !== undefined && name.toUpperCase().startsWith(`${first}-`) ? first : null;
}

export function parseWstackEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export interface StreamSessionInput {
  pk: string;
  projectId: string | null;
  name: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  tickets: string[];
  prs: PrRef[];
  skills: string[];
  costUsd: number | null;
  startedAt: string;
  lastActivityAt: string;
  liveStatus: LiveStatus | null;
  recap: string | null;
}
export interface StreamPlanInput {
  path: string;
  mtime: string;
}
export interface StreamWorkflowInput {
  file: string;
  env: Record<string, string>;
  mtime: string;
}
export interface StreamWorktreeInput {
  path: string;
  branch: string;
  ticket: string | null;
  updatedAt: string | null;
}
export interface TicketSignalInput {
  sessions: StreamSessionInput[];
  prs: StreamPr[];
  plans: StreamPlanInput[];
  workflows: StreamWorkflowInput[];
  worktrees: StreamWorktreeInput[];
}

export function prTickets(
  p: StreamPr,
  pattern: string | null,
): Array<{ ticket: string; source: 'pr_title' | 'pr_body' | 'branch' }> {
  const out: Array<{ ticket: string; source: 'pr_title' | 'pr_body' | 'branch' }> = [];
  for (const t of extractTicketsFrom(p.title, pattern)) out.push({ ticket: t, source: 'pr_title' });
  for (const t of extractTicketsFrom(p.headRef, pattern)) out.push({ ticket: t, source: 'branch' });
  return out;
}

export function collectTicketSignals(input: TicketSignalInput, pattern: string | null): TicketSignal[] {
  const out: TicketSignal[] = [];
  const seen = new Set<string>();
  const add = (s: TicketSignal) => {
    const k = `${s.ticket}|${s.kind}|${s.ref}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const prByUrl = new Map(input.prs.map((p) => [p.pr.url, p]));

  for (const s of input.sessions) {
    for (const t of s.tickets)
      add({ ticket: t.toUpperCase(), kind: 'session', ref: s.pk, source: 'session_tickets' });
    for (const text of [s.firstPrompt, s.lastPrompt, s.name]) {
      for (const t of extractTicketsFrom(text, pattern))
        add({ ticket: t, kind: 'session', ref: s.pk, source: 'prompt' });
    }
    for (const ref of s.prs) {
      const p = prByUrl.get(ref.url);
      if (!p) continue;
      for (const { ticket } of prTickets(p, pattern))
        add({ ticket, kind: 'session', ref: s.pk, source: 'pr_title' });
    }
  }
  for (const p of input.prs) {
    for (const { ticket, source } of prTickets(p, pattern))
      add({ ticket, kind: 'pr', ref: p.pr.url, source });
  }
  for (const plan of input.plans) {
    const t = planTicket(plan.path, pattern);
    if (t) add({ ticket: t, kind: 'plan', ref: plan.path, source: 'plan_file' });
  }
  for (const w of input.workflows) {
    for (const t of [
      ...extractTicketsFrom(w.env.BRANCH, pattern),
      ...extractTicketsFrom(w.env.WORKFLOW_ID, pattern),
    ]) {
      add({ ticket: t, kind: 'workflow', ref: w.file, source: 'wstack_workflow' });
    }
  }
  for (const wt of input.worktrees) {
    const tickets = wt.ticket ? [wt.ticket.toUpperCase()] : extractTicketsFrom(wt.branch, pattern);
    for (const t of tickets) add({ ticket: t, kind: 'worktree', ref: wt.path, source: 'worktree' });
  }
  return out;
}

const linkKey = (x: { ticket: string; kind: StreamLinkKind; ref: string }) =>
  `${x.ticket}|${x.kind}|${x.ref}`;

export function applyManualLinks(signals: TicketSignal[], links: StreamLink[]): TicketSignal[] {
  const excluded = new Set(links.filter((l) => l.excluded).map(linkKey));
  const out = signals.filter((s) => !excluded.has(linkKey(s)));
  const present = new Set(out.map(linkKey));
  for (const l of links) {
    if (l.excluded || l.origin !== 'manual' || present.has(linkKey(l))) continue;
    out.push({ ticket: l.ticket, kind: l.kind, ref: l.ref, source: 'manual' });
    present.add(linkKey(l));
  }
  return out;
}

export interface TicketGroup {
  ticket: string;
  refs: Record<StreamLinkKind, string[]>;
}

export function groupSignals(signals: TicketSignal[]): TicketGroup[] {
  const map = new Map<string, TicketGroup>();
  for (const s of signals) {
    let g = map.get(s.ticket);
    if (!g) {
      g = { ticket: s.ticket, refs: { session: [], pr: [], plan: [], worktree: [], workflow: [] } };
      map.set(s.ticket, g);
    }
    if (!g.refs[s.kind].includes(s.ref)) g.refs[s.kind].push(s.ref);
  }
  return [...map.values()].sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true }));
}

export interface StageInput {
  prs: StreamPr[];
  sessions: Array<{ skills: string[]; liveStatus: LiveStatus | null }>;
  hasWorktrees: boolean;
}

export function computeStreamStage(i: StageInput): StreamStage {
  if (i.sessions.some((s) => s.skills.some((k) => RELEASE_SKILLS.includes(k)))) return 'released';
  const backmerges = i.prs.filter((p) => p.isBackmerge);
  const main = i.prs.filter((p) => !p.isBackmerge);
  if (backmerges.some((p) => p.state === 'merged')) return 'backmerged';
  if (main.some((p) => p.state === 'merged')) return 'merged';
  if (main.some((p) => p.state === 'open')) return 'pr_open';
  if (i.sessions.some((s) => s.liveStatus === 'review' || s.skills.some((k) => REVIEW_SKILLS.includes(k))))
    return 'in_review';
  if (i.sessions.length > 0 || i.hasWorktrees) return 'implementing';
  return 'planned';
}
