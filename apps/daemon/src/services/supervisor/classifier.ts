import type { SupervisorIntent } from '@orc/api-contract';
import { redact } from '@orc/core';
import { execa } from 'execa';
import { z } from 'zod';

export const ClassifierOutput = z
  .object({
    decision: z.enum(['answer', 'escalate']),
    answer: z.string().max(500).nullable(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type ClassifierOutput = z.infer<typeof ClassifierOutput>;

export interface ClassifyInput {
  question: string;
  context: string;
  intent: SupervisorIntent | null;
  cannedAnswer: string | null;
  model: string;
}

export interface ClassifyResult {
  output: ClassifierOutput;
  costUsd: number | null;
  model: string;
  durationMs: number;
}

export type Classifier = (i: ClassifyInput) => Promise<ClassifyResult>;

export class ClassifierError extends Error {
  readonly code = 'classifier_failed' as const;
}

export function buildClassifierPrompt(i: ClassifyInput): string {
  return [
    'You are a cautious supervisor for a coding agent. Decide whether a routine question can be answered automatically.',
    '',
    'Answer ONLY when all of these hold:',
    '- the question is routine (continue, run the tests, proceed with an already approved plan, retry a transient error)',
    '- answering cannot cause a merge, a deploy, a production change, data loss or a credential change',
    '- the intended answer below is clearly the right one',
    'Otherwise escalate. When in doubt, escalate.',
    '',
    `Rule match: ${i.intent ?? 'none'}`,
    `Intended answer: ${i.cannedAnswer ?? '(none)'}`,
    '',
    'Context:',
    redact(i.context).slice(0, 800),
    '',
    'Agent question:',
    redact(i.question).slice(0, 1200),
    '',
    'Reply with only this JSON object, no prose and no code fences:',
    '{"decision":"answer"|"escalate","answer":string|null,"confidence":0.0-1.0,"reason":"short reason"}',
  ].join('\n');
}

export function parseClassifierText(text: string): ClassifierOutput {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new ClassifierError(`classifier did not return JSON: ${cleaned.slice(0, 120)}`);
  let value: unknown;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new ClassifierError(`classifier returned invalid JSON: ${(e as Error).message}`);
  }
  const parsed = ClassifierOutput.safeParse(value);
  if (!parsed.success) {
    throw new ClassifierError(
      `classifier output failed validation: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export function buildClassifierArgs(o: { model: string; maxBudgetUsd: number }): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    o.model,
    '--tools',
    '',
    '--no-session-persistence',
    '--safe-mode',
    '--max-budget-usd',
    o.maxBudgetUsd.toFixed(2),
  ];
}

const CliResult = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean().default(false),
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
  })
  .loose();

export function createClaudeClassifier(o: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
}): Classifier {
  return async (i) => {
    const started = Date.now();
    const res = await execa(
      o.command,
      buildClassifierArgs({ model: i.model, maxBudgetUsd: o.maxBudgetUsd ?? 0.05 }),
      {
        cwd: o.cwd,
        input: buildClassifierPrompt(i),
        timeout: o.timeoutMs ?? 30_000,
        forceKillAfterDelay: 3_000,
        reject: false,
        env: o.env,
      },
    );
    if (res.timedOut) throw new ClassifierError(`classifier timed out after ${o.timeoutMs ?? 30_000} ms`);
    if (res.exitCode !== 0) {
      throw new ClassifierError(
        `classifier exited with ${res.exitCode}: ${String(res.stderr ?? '').slice(-200)}`,
      );
    }
    let payload: z.infer<typeof CliResult>;
    try {
      payload = CliResult.parse(JSON.parse(String(res.stdout)));
    } catch (e) {
      throw new ClassifierError(`classifier CLI output was not a result object: ${(e as Error).message}`);
    }
    if (payload.is_error) throw new ClassifierError('classifier reported an error');
    return {
      output: parseClassifierText(payload.result ?? ''),
      costUsd: payload.total_cost_usd ?? null,
      model: i.model,
      durationMs: payload.duration_ms ?? Date.now() - started,
    };
  };
}
