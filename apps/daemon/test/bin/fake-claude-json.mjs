#!/usr/bin/env node
// Fake `claude -p --output-format json`. FAKE_RESULT is the assistant's result text; FAKE_EXIT forces a failure.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_ARGS_FILE)
  appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, stdin })}\n`);
if (process.env.FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_EXIT) {
  process.stderr.write('credit balance too low\n');
  process.exit(Number(process.env.FAKE_EXIT));
} else {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result:
        process.env.FAKE_RESULT ??
        '{"decision":"answer","answer":"Yes, continue.","confidence":0.93,"reason":"routine continue"}',
      session_id: 'classifier',
      duration_ms: 420,
      total_cost_usd: 0.0021,
    })}\n`,
  );
}
