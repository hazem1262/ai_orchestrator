/**
 * Claude's argv for a plan-approval launch: every permission-mode switch from the resume profile is
 * dropped (`--dangerously-skip-permissions`, `--permission-mode <mode>`, `--permission-mode=<mode>`)
 * and `--permission-mode plan` is appended, so the session stops at ExitPlanMode for approval.
 */
export function applyPlanMode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dangerously-skip-permissions') continue;
    if (a === '--permission-mode') {
      i++;
      continue;
    }
    if (a.startsWith('--permission-mode=')) continue;
    out.push(a);
  }
  return [...out, '--permission-mode', 'plan'];
}
