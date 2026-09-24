import type { AgentNode } from '@orc/core';

export const CONDUCTOR_STEPS = [
  'repo-resolver',
  'branch',
  'code',
  'lint',
  'test',
  'build',
  'visual-verify',
] as const;
export type ConductorStep = (typeof CONDUCTOR_STEPS)[number];

// Order matters: more specific steps first.
const RULES: ReadonlyArray<{ step: ConductorStep; re: RegExp }> = [
  { step: 'repo-resolver', re: /repo[-_ ]?resolv|resolve (?:the )?repo/i },
  { step: 'visual-verify', re: /visual[-_ ]?verif|screenshot|playwright/i },
  { step: 'branch', re: /\bbranch\b|worktree/i },
  { step: 'lint', re: /\blint(?:er|ing)?\b|biome|eslint/i },
  { step: 'test', re: /\btests?\b|vitest|jest|pytest|\bqa\b/i },
  { step: 'build', re: /\bbuild\b|compile/i },
  { step: 'code', re: /\bcode(?:r)?\b|implement|developer|\bfix\b/i },
];

export function conductorStep(a: Pick<AgentNode, 'agentType' | 'description'>): ConductorStep | null {
  const type = a.agentType.toLowerCase().replace(/^conductor[:/_-]/, '');
  const exact = CONDUCTOR_STEPS.find((s) => type === s || type === `${s}-agent` || type.endsWith(`:${s}`));
  if (exact) return exact;
  for (const r of RULES) if (r.re.test(a.agentType)) return r.step;
  for (const r of RULES) if (r.re.test(a.description)) return r.step;
  return null;
}

export function isConductorSession(skills: readonly string[]): boolean {
  return skills.some((s) => s === 'conductor' || s.endsWith(':conductor'));
}

export type ChainStatus = 'pending' | 'running' | 'done' | 'error';

export interface ChainStepView {
  step: ConductorStep;
  agents: AgentNode[];
  status: ChainStatus;
}

export function conductorChain(
  agents: readonly AgentNode[],
  opts: { isConductor: boolean },
): ChainStepView[] | null {
  if (!opts.isConductor) return null;
  const buckets = new Map<ConductorStep, AgentNode[]>(CONDUCTOR_STEPS.map((s) => [s, []]));
  let mapped = 0;
  for (const a of agents) {
    const s = conductorStep(a);
    if (!s) continue;
    buckets.get(s)?.push(a);
    mapped++;
  }
  if (mapped < 2) return null;
  return CONDUCTOR_STEPS.map((step) => {
    const list = buckets.get(step) ?? [];
    const status: ChainStatus =
      list.length === 0
        ? 'pending'
        : list.some((a) => a.status === 'error')
          ? 'error'
          : list.some((a) => a.status === 'running')
            ? 'running'
            : 'done';
    return { step, agents: list, status };
  });
}
