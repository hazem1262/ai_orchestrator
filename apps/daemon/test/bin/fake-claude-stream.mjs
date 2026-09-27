#!/usr/bin/env node
// Fake `claude -p --output-format stream-json`. Modes: success | plan | error | hang (env FAKE_MODE).
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_ARGS_FILE)
  appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, stdin })}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sid = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
const mode = process.env.FAKE_MODE ?? 'success';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({
  type: 'system',
  subtype: 'init',
  session_id: sid,
  model: 'claude-sonnet-5',
  cwd: process.cwd(),
  tools: ['Read'],
});
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  out({
    type: 'assistant',
    session_id: sid,
    message: {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
      ],
    },
  });
  out({
    type: 'user',
    session_id: sid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  });
  process.stdout.write('this line is not json\n');
  if (mode === 'error') {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sid,
      duration_ms: 500,
      num_turns: 1,
      total_cost_usd: 0.02,
    });
    process.exit(1);
  }
  const text =
    mode === 'plan'
      ? 'Plan:\n1. Update the flaky test\n2. Fix the retry logic'
      : 'Done. Opened https://github.com/example-org/svc/pull/12 (password=hunter2)';
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: sid,
    duration_ms: 1234,
    num_turns: 3,
    total_cost_usd: 0.42,
  });
}
