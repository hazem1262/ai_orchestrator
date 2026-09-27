export type HookEventName = 'SessionStart' | 'Stop' | 'Notification' | 'PreToolUse' | 'PostToolUse';

/** The only fields kept from a hook payload. */
export interface HookFields {
  sessionId: string;
  event: string;
  message: string | null;
  tool: string | null;
}

export interface HookSignal {
  sessionId: string;
  event: string;
  status: 'busy' | 'idle' | 'waiting';
  waitingFor: string | null;
  currentTool: string | null;
}
