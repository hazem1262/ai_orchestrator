import { classifyClaudeRecord, contentText } from '../claude/records.ts';
import { redact } from '../redact/redact.ts';
import type { Stage, TestResult } from '../types/index.ts';
import { categorizeTool, inferStage, type ToolCategory } from './stage.ts';
import { isTestCommand, parseTestOutput } from './tests.ts';

/**
 * Reduced live state for a running transcript, as shown on a Live Board card. Fed one JSONL
 * record at a time by `LiveReducer.apply`; never reads a file itself (that is the daemon's job
 * via `readJsonlFrom`). Carried across tail reads by the caller (see Task 5's watcher / Task 7's
 * LiveTracker): keep the `LiveReducer` instance alive per session and call `apply` once per new
 * line, rather than re-scanning the whole transcript on every tail read.
 */
export interface TranscriptLive {
  turn: number;
  lastPrompt: string | null;
  currentTool: string | null;
  stage: Stage | null;
  backgroundJobs: number;
  runningSubagents: number;
  contextFill: number | null;
  lastTest: TestResult | null;
  turnEnded: boolean;
  turnChangedFiles: string[];
  turnPrs: number;
  lastApiError: string | null;
  permissionMode: string | null;
  lastActivityAt: string | null;
}

export interface LiveReducerEffects {
  testRecorded: TestResult | null;
  turnEnded: number | null;
}

export interface LiveReducer {
  apply(value: unknown): LiveReducerEffects;
  snapshot(): TranscriptLive;
}

export const emptyTranscriptLive = (): TranscriptLive => ({
  turn: 0,
  lastPrompt: null,
  currentTool: null,
  stage: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
  lastTest: null,
  turnEnded: false,
  turnChangedFiles: [],
  turnPrs: 0,
  lastApiError: null,
  permissionMode: null,
  lastActivityAt: null,
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TURN_END = new Set(['turn_duration', 'stop_hook_summary']);

interface Pending {
  name: string;
  command: string | null;
  backgroundShell: boolean;
  watchShell: string | null;
}

/**
 * Builds an incremental reducer: `apply` folds one parsed JSONL record (or `undefined`/malformed
 * input, which is a no-op) into carried state and returns the effects that just happened
 * (`testRecorded`, `turnEnded`); `snapshot` returns a defensive copy of the current
 * `TranscriptLive`. Cheap by design — O(1) per call, no re-scanning — because the daemon calls
 * `apply` once per new line on every tail read of a live transcript.
 *
 * `opts.contextWindow` defaults to 200_000 (Claude's default context window). A transcript does
 * NOT record the window it was run with — measured across 171 real transcripts, every model id is
 * plain `claude-opus-5` with no `1m`/`context_1m`/`betas`/`max_context` marker anywhere, including
 * for sessions that demonstrably had a 1M window. The LiveTracker therefore infers the window from
 * the largest usage the session has reported (`contextWindowForUsage`) and reconstructs the reducer
 * when that inference widens; callers that construct a reducer directly get the 200k default and
 * should expect `contextFill` to saturate for a long session.
 */
export function createLiveReducer(opts: { contextWindow?: number } = {}): LiveReducer {
  const contextWindow = opts.contextWindow ?? 200_000;
  const s = emptyTranscriptLive();
  let categories: ToolCategory[] = [];
  const changed = new Set<string>();
  const pending = new Map<string, Pending>();
  const pendingAgents = new Set<string>();
  const shells = new Set<string>();

  const recompute = () => {
    s.turnChangedFiles = [...changed];
    s.stage = inferStage({ categories, turnEnded: s.turnEnded, changedFiles: changed.size });
    s.runningSubagents = pendingAgents.size;
    s.backgroundJobs = shells.size;
  };

  const resultText = (block: Obj): string => {
    const c = block.content;
    return typeof c === 'string' ? c : contentText(c);
  };

  return {
    apply(value: unknown): LiveReducerEffects {
      const effects: LiveReducerEffects = { testRecorded: null, turnEnded: null };
      const c = classifyClaudeRecord(value);
      switch (c.kind) {
        case 'human_prompt': {
          s.turn += 1;
          s.lastPrompt = redact(c.text).slice(0, 500);
          s.turnEnded = false;
          s.turnPrs = 0;
          s.lastApiError = null;
          s.lastActivityAt = c.rec.timestamp;
          categories = [];
          changed.clear();
          const mode = isObj(value) ? str(value.permissionMode) : null;
          if (mode) s.permissionMode = mode;
          break;
        }
        case 'assistant': {
          const msg = c.rec.message;
          s.lastActivityAt = c.rec.timestamp;
          if (c.rec.isApiErrorMessage === true) {
            s.lastApiError = redact(contentText(msg?.content)).slice(0, 300) || 'API error';
            break;
          }
          s.lastApiError = null;
          if (msg?.usage && msg.model !== '<synthetic>') {
            const u = msg.usage;
            const used =
              num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
            // Clamped as a last-resort floor only. `used > contextWindow` is not a value to round
            // off, it is evidence the window is wrong — which is why the LiveTracker sizes the
            // window from observed usage so this clamp never fires in the daemon.
            s.contextFill = Math.min(1, used / contextWindow);
          }
          const content = msg?.content;
          const blocks: unknown[] = Array.isArray(content) ? content : [];
          for (const b of blocks) {
            if (!isObj(b) || b.type !== 'tool_use') continue;
            const name = str(b.name) ?? 'unknown';
            const id = str(b.id) ?? '';
            const input = isObj(b.input) ? b.input : {};
            s.currentTool = name;
            categories.push(categorizeTool(name, input));
            if (EDIT_TOOLS.has(name)) {
              const fp = str(input.file_path) ?? str(input.notebook_path);
              if (fp) changed.add(fp);
            }
            if (AGENT_TOOLS.has(name) && input.run_in_background !== true) pendingAgents.add(id);
            if (name === 'KillShell' || name === 'KillBash') {
              const sid = str(input.shell_id) ?? str(input.bash_id);
              if (sid) shells.delete(sid);
            }
            const command = name === 'Bash' ? str(input.command) : null;
            pending.set(id, {
              name,
              command: command && isTestCommand(command) ? command : null,
              backgroundShell: name === 'Bash' && input.run_in_background === true,
              watchShell: name === 'BashOutput' ? (str(input.bash_id) ?? str(input.shell_id)) : null,
            });
          }
          break;
        }
        case 'tool_result': {
          s.lastActivityAt = c.rec.timestamp;
          const content = c.rec.message?.content;
          const blocks: unknown[] = Array.isArray(content) ? content : [];
          for (const b of blocks) {
            if (!isObj(b) || b.type !== 'tool_result') continue;
            const id = str(b.tool_use_id) ?? '';
            pendingAgents.delete(id);
            const p = pending.get(id);
            pending.delete(id);
            if (!p) continue;
            const text = resultText(b);
            if (p.command) {
              const r = parseTestOutput(redact(p.command), text, c.rec.timestamp);
              if (r) {
                s.lastTest = r;
                effects.testRecorded = r;
              }
            }
            if (p.backgroundShell) {
              const m = /ID:\s*([A-Za-z0-9_-]+)/.exec(text);
              if (m?.[1]) shells.add(m[1]);
            }
            if (p.watchShell && /<status>(?:completed|killed|failed)<\/status>/.test(text))
              shells.delete(p.watchShell);
          }
          break;
        }
        case 'system': {
          if (c.subtype && TURN_END.has(c.subtype) && !s.turnEnded && s.turn > 0) {
            s.turnEnded = true;
            effects.turnEnded = s.turn;
          }
          break;
        }
        case 'session_meta': {
          if (c.type === 'pr-link') s.turnPrs += 1;
          if (c.type === 'permission-mode' || c.type === 'mode') {
            const mode = str(c.rec.permissionMode) ?? str(c.rec.mode);
            if (mode) s.permissionMode = mode;
          }
          break;
        }
        default:
          break;
      }
      recompute();
      return effects;
    },
    snapshot(): TranscriptLive {
      return {
        ...s,
        turnChangedFiles: [...s.turnChangedFiles],
        lastTest: s.lastTest ? { ...s.lastTest } : null,
      };
    },
  };
}
