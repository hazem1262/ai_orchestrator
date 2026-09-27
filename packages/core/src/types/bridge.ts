import type { LiveStatus } from './session.ts';

export type HookEventName = 'SessionStart' | 'Stop' | 'Notification' | 'PreToolUse' | 'PostToolUse';

export interface HookSignal {
  sessionId: string;
  event: HookEventName;
  status: LiveStatus;
  waitingFor: string | null;
  currentTool: string | null;
}
