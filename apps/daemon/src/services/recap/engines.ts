import { mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd, type PriceTable, type RecapEngineId } from '@orc/core';
import { execa } from 'execa';

export interface RecapRunResult {
  text: string;
  costUsd: number;
  model: string;
  engine: RecapEngineId;
}
export interface RecapRunOptions {
  model: string;
  maxBudgetUsd: number;
  timeoutMs?: number;
}
export interface RecapEngine {
  id: RecapEngineId;
  run(prompt: string, opts: RecapRunOptions): Promise<RecapRunResult>;
}

export type RecapEngineErrorCode = 'engine_failed' | 'engine_unavailable' | 'bad_output';

export class RecapEngineError extends Error {
  constructor(
    readonly code: RecapEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecapEngineError';
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

export function parseClaudePrintJson(stdout: string): { result: string; costUsd: number; isError: boolean } {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (!line) throw new RecapEngineError('bad_output', 'claude -p printed no JSON');
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new RecapEngineError('bad_output', 'claude -p printed invalid JSON');
  }
  const o = v as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
  if (typeof o.result !== 'string')
    throw new RecapEngineError('bad_output', 'unexpected claude -p JSON shape');
  return {
    result: o.result,
    costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0,
    isError: o.is_error === true,
  };
}

export function claudePrintArgs(model: string, maxBudgetUsd: number): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    '--max-budget-usd',
    maxBudgetUsd.toFixed(2),
  ];
}

export function createClaudeCliEngine(opts: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): RecapEngine {
  return {
    id: 'claude-cli',
    async run(prompt, o) {
      mkdirSync(opts.cwd, { recursive: true });
      // The child gets its own process group so a timeout kills everything it spawned. Killing only
      // the direct child can leave a grandchild holding stdout open, and the run would then wait for it.
      const child = execa(opts.command, claudePrintArgs(o.model, o.maxBudgetUsd), {
        input: prompt,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        extendEnv: false,
        detached: true,
        reject: false,
        stripFinalNewline: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // the group already exited
        }
      }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const res = await child
        .catch((err: unknown) => {
          throw new RecapEngineError(
            'engine_unavailable',
            `cannot start ${opts.command}: ${(err as Error).message}`,
          );
        })
        .finally(() => clearTimeout(timer));
      if (timedOut) throw new RecapEngineError('engine_failed', 'claude -p timed out');
      // execa with reject:false resolves spawn failures (ENOENT, EACCES) with no exit code.
      if (res.exitCode === undefined)
        throw new RecapEngineError('engine_unavailable', `cannot start ${opts.command}`);
      const stdout = String(res.stdout ?? '');
      if (res.exitCode !== 0) {
        let detail = `exit ${res.exitCode}`;
        try {
          detail = parseClaudePrintJson(stdout).result.slice(0, 200);
        } catch {
          // keep the exit code only
        }
        throw new RecapEngineError('engine_failed', `claude -p failed: ${detail}`);
      }
      const parsed = parseClaudePrintJson(stdout);
      if (parsed.isError)
        throw new RecapEngineError(
          'engine_failed',
          `claude -p reported an error: ${parsed.result.slice(0, 200)}`,
        );
      return { text: parsed.result.trim(), costUsd: parsed.costUsd, model: o.model, engine: 'claude-cli' };
    },
  };
}

export type MessagesClient = {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

const MAX_OUTPUT_TOKENS = 2048;

export function createAnthropicApiEngine(opts: {
  getApiKey: () => Promise<string | null>;
  prices: () => PriceTable;
  clientFactory?: (apiKey: string) => MessagesClient;
}): RecapEngine {
  const factory = opts.clientFactory ?? ((apiKey: string): MessagesClient => new Anthropic({ apiKey }));
  return {
    id: 'anthropic-api',
    async run(prompt, o) {
      const key = await opts.getApiKey();
      if (!key)
        throw new RecapEngineError(
          'engine_unavailable',
          'no Anthropic API key configured (set ANTHROPIC_API_KEY)',
        );
      let msg: Anthropic.Message;
      try {
        msg = await factory(key).messages.create({
          model: o.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError)
          throw new RecapEngineError('engine_unavailable', 'Anthropic API key rejected');
        if (err instanceof Anthropic.RateLimitError)
          throw new RecapEngineError('engine_failed', 'Anthropic API rate limited');
        if (err instanceof Anthropic.APIError)
          throw new RecapEngineError('engine_failed', `Anthropic API error ${err.status ?? ''}`.trim());
        throw new RecapEngineError('engine_failed', `Anthropic API call failed: ${(err as Error).message}`);
      }
      if (msg.stop_reason === 'refusal')
        throw new RecapEngineError('engine_failed', 'the model declined the recap request');
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) throw new RecapEngineError('bad_output', 'empty model response');
      const u = msg.usage;
      const costUsd =
        estimateCostUsd(
          o.model,
          {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          },
          opts.prices(),
        ) ?? 0;
      return { text, costUsd, model: o.model, engine: 'anthropic-api' };
    },
  };
}
