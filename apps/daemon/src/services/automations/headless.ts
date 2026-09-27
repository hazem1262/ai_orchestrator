import { chmodSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { redact, redactDeep } from '@orc/core';
import { execa } from 'execa';
import { z } from 'zod';
import { automationClaudeArgs } from './guardrails.ts';

export interface HeadlessRunOptions {
  command: string;
  cwd: string;
  prompt: string;
  model?: string;
  permissionMode: 'plan' | 'acceptEdits';
  sessionId?: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
  logFile: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HeadlessRunResult {
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  numTurns: number | null;
  resultText: string;
  isError: boolean;
  subtype: string | null;
  timedOut: boolean;
  exitCode: number | null;
  events: number;
  stderrTail: string;
}

export type HeadlessRunner = (o: HeadlessRunOptions) => Promise<HeadlessRunResult>;

export type StreamEvent =
  | { type: 'init'; sessionId: string; model: string | null }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; name: string }
  | {
      type: 'result';
      subtype: string;
      isError: boolean;
      text: string;
      sessionId: string;
      costUsd: number | null;
      durationMs: number | null;
      numTurns: number | null;
    };

const InitLine = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string(),
    model: z.string().optional(),
  })
  .loose();
const AssistantLine = z
  .object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.unknown()) }).loose() })
  .loose();
const ResultLine = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().default(false),
    result: z.string().optional(),
    session_id: z.string(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
  })
  .loose();
const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).loose();
const ToolBlock = z.object({ type: z.literal('tool_use'), name: z.string() }).loose();

/** Every event in one stream-json line; an assistant line with text and tool calls yields one of each. */
export function parseStreamEvents(line: string): StreamEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  const init = InitLine.safeParse(value);
  if (init.success)
    return [{ type: 'init', sessionId: init.data.session_id, model: init.data.model ?? null }];
  const res = ResultLine.safeParse(value);
  if (res.success) {
    return [
      {
        type: 'result',
        subtype: res.data.subtype,
        isError: res.data.is_error,
        text: res.data.result ?? '',
        sessionId: res.data.session_id,
        costUsd: res.data.total_cost_usd ?? null,
        durationMs: res.data.duration_ms ?? null,
        numTurns: res.data.num_turns ?? null,
      },
    ];
  }
  const asst = AssistantLine.safeParse(value);
  if (!asst.success) return [];
  const texts: string[] = [];
  const tools: StreamEvent[] = [];
  for (const block of asst.data.message.content) {
    const t = TextBlock.safeParse(block);
    if (t.success && t.data.text.trim()) texts.push(t.data.text);
    const u = ToolBlock.safeParse(block);
    if (u.success) tools.push({ type: 'tool_use', name: u.data.name });
  }
  return texts.length > 0 ? [{ type: 'assistant_text', text: texts.join('\n') }, ...tools] : tools;
}

export function parseStreamLine(line: string): StreamEvent | null {
  return parseStreamEvents(line)[0] ?? null;
}

export function formatStreamLine(line: string): string | null {
  const ev = parseStreamLine(line);
  if (!ev) return null;
  switch (ev.type) {
    case 'init':
      return `● session ${ev.sessionId}${ev.model ? ` (${ev.model})` : ''}`;
    case 'assistant_text':
      return redact(ev.text);
    case 'tool_use':
      return `→ ${ev.name}`;
    case 'result':
      return `■ ${ev.subtype}${ev.costUsd !== null ? ` · $${ev.costUsd.toFixed(2)}` : ''}`;
  }
}

/** Redacts one raw stdout line for the on-disk run log; JSON lines stay valid JSON. */
export function redactStreamLine(line: string): string {
  try {
    return JSON.stringify(redactDeep(JSON.parse(line) as unknown));
  } catch {
    return redact(line);
  }
}

export function buildHeadlessArgs(o: HeadlessRunOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  if (o.model) args.push('--model', o.model);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  else if (o.sessionId) args.push('--session-id', o.sessionId);
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', o.maxBudgetUsd.toFixed(2));
  // Variadic tool lists go last; the prompt is sent on stdin, so nothing positional follows them.
  args.push(...automationClaudeArgs({ permissionMode: o.permissionMode }));
  return args;
}

export const runHeadless: HeadlessRunner = async (o) => {
  mkdirSync(dirname(o.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(o.logFile, '', { flag: 'a', mode: 0o600 });
  chmodSync(o.logFile, 0o600);
  const log = createWriteStream(o.logFile, { flags: 'a' });
  const started = Date.now();
  const sub = execa(o.command, buildHeadlessArgs(o), {
    cwd: o.cwd,
    input: o.prompt,
    timeout: o.timeoutMs,
    forceKillAfterDelay: 3_000,
    reject: false,
    buffer: { stdout: false, stderr: true },
    env: { ...o.env, ORC_AUTOMATION: '1' },
    cancelSignal: o.signal,
  });
  let sessionId: string | null = o.resumeSessionId ?? o.sessionId ?? null;
  let result: Extract<StreamEvent, { type: 'result' }> | null = null;
  let lastText = '';
  let events = 0;
  if (sub.stdout) {
    const rl = createInterface({ input: sub.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (!line.trim()) continue;
      log.write(`${redactStreamLine(line)}\n`);
      for (const ev of parseStreamEvents(line)) {
        events++;
        if (ev.type === 'init') sessionId = ev.sessionId;
        else if (ev.type === 'assistant_text') lastText = ev.text;
        else if (ev.type === 'result') {
          result = ev;
          sessionId = ev.sessionId;
        }
      }
    }
  }
  const done = await sub;
  await new Promise<void>((resolve) => log.end(resolve));
  const timedOut = Boolean(done.timedOut);
  return {
    sessionId,
    costUsd: result?.costUsd ?? null,
    durationMs: result?.durationMs ?? Date.now() - started,
    numTurns: result?.numTurns ?? null,
    resultText: redact(result?.text || lastText),
    isError: timedOut || (result ? result.isError : true),
    subtype: result?.subtype ?? null,
    timedOut,
    exitCode: done.exitCode ?? null,
    events,
    stderrTail: redact(String(done.stderr ?? '')).slice(-2000),
  };
};
