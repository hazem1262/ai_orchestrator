/**
 * Keys for Claude Code's ExitPlanMode dialog. If the TUI changes, update only this file.
 * - approve: option "1" ("Yes, …") is selected by its number key.
 * - reject: Escape dismisses the dialog ("No, keep planning") and returns to the prompt.
 */
export const PLAN_KEYS = { approve: '1', reject: '\x1b', rejectSettleMs: 300 } as const;

export function rejectionPrompt(feedback: string): string {
  return `The plan is not approved yet. Do not start implementing. Revise the plan using this feedback, then present it again:\n\n${feedback.trim()}`;
}
