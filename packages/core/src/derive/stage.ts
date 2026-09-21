import type { Stage } from '../types/session.ts';
import { isTestCommand } from './tests.ts';

export type ToolCategory = 'read' | 'edit' | 'test' | 'other';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_BASH =
  /^\s*(?:rg|grep|cat|head|tail|ls|find|fd|tree|wc|git\s+(?:log|diff|status|show|blame)|gh\s+(?:pr|issue)\s+view)\b/;

/**
 * Buckets a transcript tool call into the four categories the stage bar cares about.
 * `Read`/`Grep`/`Glob`/`LS`/`WebFetch`/`WebSearch`/`NotebookRead` are always `read`; `Edit`,
 * `Write`, `MultiEdit`, `NotebookEdit` are always `edit`. `Bash` is ambiguous, so its category
 * is derived from `input.command`: a test runner (reusing `isTestCommand` from `./tests.ts`
 * rather than a second matcher) is `test`, a read-only inspection command (`rg`, `grep`, `cat`,
 * `git diff`/`log`/`status`/`show`/`blame`, `gh pr/issue view`, etc.) is `read`, and anything
 * else (installs, builds, git commit/push, arbitrary scripts) is `other`. `Task`/`Agent`, MCP
 * tools (`mcp__<server>__<tool>`) and any unrecognised name are `other` — there isn't enough
 * signal in the name alone to place them on the understand/modify/test bar. `other` never
 * places the bar on its own in `inferStage` below — see there for what a wholly-`other` turn
 * (e.g. subagent dispatch, MCP-only work) resolves to.
 */
export function categorizeTool(tool: string, input: unknown): ToolCategory {
  if (READ_TOOLS.has(tool)) return 'read';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (tool === 'Bash') {
    const command =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command
        : '';
    if (isTestCommand(command)) return 'test';
    if (READ_BASH.test(command)) return 'read';
  }
  return 'other';
}

const RANK: Record<Exclude<ToolCategory, 'other'>, { rank: number; stage: Stage }> = {
  read: { rank: 1, stage: 'understand' },
  edit: { rank: 2, stage: 'modify' },
  test: { rank: 3, stage: 'test' },
};

/**
 * Maps the current turn's observed activity to the four-step stage bar (F1 on the Live Board
 * card): reads/searches put the card at `understand`, an edit advances it to `modify`, a test
 * run advances it to `test`, and once the turn has ended with at least one changed file the
 * card moves to `review` regardless of what ran last. `other`-categorised calls (installs, MCP
 * calls, subagent dispatch, ...) never move the bar on their own — a turn made up entirely of
 * `other` (e.g. a `/conductor` session only dispatching `Task`/`Agent` subagents, a Linear
 * MCP-only turn, or `TodoWrite` plus an install) shows no stage rather than a false
 * `understand`, unless the turn also ended having changed files, in which case `review` still
 * applies.
 *
 * Returns `null` when there isn't enough signal to place the card anywhere: no tool activity at
 * all in the turn, or activity that is entirely `other` (nothing ranked as read/edit/test). This
 * is a deliberate "don't guess" default — an idle, freshly-started, or subagent/MCP-only session
 * should show no stage rather than a fabricated one.
 */
export function inferStage(s: {
  categories: ToolCategory[];
  turnEnded: boolean;
  changedFiles: number;
}): Stage | null {
  if (s.categories.length === 0) return null;
  if (s.turnEnded && s.changedFiles > 0) return 'review';
  let best: { rank: number; stage: Stage } | null = null;
  for (const category of s.categories) {
    if (category === 'other') continue;
    const ranked = RANK[category];
    if (!best || ranked.rank > best.rank) best = ranked;
  }
  return best?.stage ?? null;
}
