import type Database from 'better-sqlite3';
import type { OrcDb } from '../../src/db/client.ts';
import { insertEvents } from '../../src/db/repos/events.ts';
import { upsertSession } from '../../src/db/repos/sessions.ts';
import { makeEvent, makeSession } from '../factories.ts';

const TOOLS = ['build', 'lint', 'gateway', 'migration', 'worker', 'report', 'export', 'tenant'] as const;
const TOPICS = [
  'notification service retries',
  'SLA deadline weekend rule',
  'kubectl rollout restart for api',
  'refactor repository layer',
  'flaky vitest suite',
] as const;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Deterministic synthetic history: 3 000-word vocabulary, one "topic" session in twenty, a ticket in one in seven. */
export function seedPerfDb(
  db: OrcDb,
  raw: Database.Database,
  o: { sessions: number; eventsPerSession: number },
): void {
  const rand = rng(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const sentence = (n: number) =>
    Array.from({ length: n }, () => `word${Math.floor(rand() * 3000)}`).join(' ');
  raw.transaction(() => {
    for (let i = 0; i < o.sessions; i++) {
      const id = `perf-${i}`;
      const topic = i % 20 === 0 ? pick(TOPICS) : sentence(3);
      const ticket = i % 7 === 0 ? `SAF-${1000 + i}` : '';
      const day = String(1 + (i % 28)).padStart(2, '0');
      const hour = String(8 + (i % 12)).padStart(2, '0');
      upsertSession(
        db,
        makeSession({
          id,
          name: `${topic} ${i}`,
          firstPrompt: `please look at ${topic} ${ticket}`.trim(),
          startedAt: `2026-08-${day}T08:00:00.000Z`,
          lastActivityAt: `2026-08-${day}T${hour}:00:00.000Z`,
          tickets: ticket ? [ticket] : [],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: Math.round(rand() * 2000) / 100,
          },
        }),
      );
      const events = Array.from({ length: o.eventsPerSession }, (_, k) => {
        const kind =
          k % 4 === 0 ? 'prompt' : k % 4 === 1 ? 'assistant_text' : k % 4 === 2 ? 'tool_call' : 'tool_result';
        const text =
          k === 0 ? `please look at ${topic} ${ticket} ${sentence(10)}` : `${sentence(12)} ${sentence(20)}`;
        return makeEvent({
          seq: k + 1,
          sessionId: id,
          turn: Math.floor(k / 4) + 1,
          kind,
          text: kind === 'tool_call' ? null : text,
          tool: kind === 'tool_call' ? 'Bash' : null,
          input: kind === 'tool_call' ? { command: `pnpm ${pick(TOOLS)} --filter ${pick(TOOLS)}` } : null,
        });
      });
      insertEvents(db, `claude:${id}`, events);
    }
  })();
}
