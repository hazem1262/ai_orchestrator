import { describe, expect, it } from 'vitest';
import { hookStatusFor, hookWins, mapHookPayload, pickHookFields } from './hooks.ts';

describe('hook mapping', () => {
  it('keeps only the allowed fields', () => {
    expect(
      pickHookFields({
        session_id: 's',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'SECRET' },
        prompt: 'SECRET',
        transcript_path: '/x',
      }),
    ).toEqual({ sessionId: 's', event: 'PreToolUse', message: null, tool: 'Bash' });
    expect(pickHookFields({ hook_event_name: 'Stop' })).toBeNull();
    expect(pickHookFields('nope')).toBeNull();
  });

  it('maps events to statuses', () => {
    expect(
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'Stop',
        'SubagentStop',
      ].map(hookStatusFor),
    ).toEqual(['idle', 'busy', 'busy', 'busy', 'waiting', 'idle', null]);
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit' })).toEqual({
      sessionId: 's',
      event: 'PreToolUse',
      status: 'busy',
      waitingFor: null,
      currentTool: 'Edit',
    });
    expect(
      mapHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Edit' })?.currentTool,
    ).toBeNull();
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'Notification' })?.waitingFor).toBe(
      'input needed',
    );
    expect(
      mapHookPayload({
        session_id: 's',
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      })?.waitingFor,
    ).toBe('Claude needs your permission to use Bash');
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'PreCompact' })).toBeNull();
  });

  it('lets a fresh hook override an older registry status only', () => {
    expect(hookWins(2000, 1000, 3000, 120_000)).toBe(true);
    expect(hookWins(1000, 2000, 3000, 120_000)).toBe(false);
    expect(hookWins(1000, null, 200_000, 120_000)).toBe(false);
    expect(hookWins(null, 0, 1, 120_000)).toBe(false);
  });
});
