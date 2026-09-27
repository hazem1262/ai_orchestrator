import type { HookFields, HookSignal } from '../types/index.ts';

/** The Claude Code hook events the real-time bridge maps to a live status. */
export const BRIDGE_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
];

/**
 * Generous against any real hook payload — Claude Code sends the submitted prompt and the tool
 * input, both of which we discard — and small enough that the ingest cannot be used to make the
 * daemon buffer.
 */
export const HOOK_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_TEXT = 300;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TEXT) : null;

/**
 * The only fields kept from a hook payload. The rest (the prompt, the tool input,
 * `transcript_path`) is dropped here and never reaches state or logs.
 */
export function pickHookFields(raw: unknown): HookFields | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const sessionId = str(o.session_id);
  const event = str(o.hook_event_name);
  if (!sessionId || !event) return null;
  return { sessionId, event, message: str(o.message), tool: str(o.tool_name) };
}

export function hookStatusFor(event: string): 'busy' | 'idle' | 'waiting' | null {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'busy';
    case 'Notification':
      return 'waiting';
    default:
      return null;
  }
}

export function mapHookPayload(raw: unknown): HookSignal | null {
  const f = pickHookFields(raw);
  if (!f) return null;
  const status = hookStatusFor(f.event);
  if (!status) return null;
  return {
    sessionId: f.sessionId,
    event: f.event,
    status,
    waitingFor: status === 'waiting' ? (f.message ?? 'input needed') : null,
    currentTool: f.event === 'PreToolUse' ? f.tool : null,
  };
}

/**
 * A hook status overrides the polled registry status while it is newer than the registry's
 * `statusUpdatedAt` and younger than `maxAgeMs`. After that polling wins again, which covers a
 * crashed or uninstalled hook.
 */
export function hookWins(
  hookAtMs: number | null,
  registryAtMs: number | null,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (hookAtMs === null) return false;
  if (nowMs - hookAtMs > maxAgeMs) return false;
  return hookAtMs > (registryAtMs ?? 0);
}
