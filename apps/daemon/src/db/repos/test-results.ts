import type { TestResult } from '@orc/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { testResults } from '../schema.ts';

type Row = typeof testResults.$inferSelect;
const toResult = (r: Row): TestResult => ({
  ts: r.ts,
  command: r.command,
  passed: r.passed,
  failed: r.failed,
  skipped: r.skipped,
  durationMs: r.durationMs,
});

export function insertTestResult(db: OrcDb, sessionPk: string, r: TestResult): boolean {
  const res = db
    .insert(testResults)
    .values({ sessionPk, ...r })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function previousTestResult(db: OrcDb, sessionPk: string, beforeTs: string): TestResult | null {
  const r = db
    .select()
    .from(testResults)
    .where(and(eq(testResults.sessionPk, sessionPk), lt(testResults.ts, beforeTs)))
    .orderBy(desc(testResults.ts))
    .get();
  return r ? toResult(r) : null;
}

export function latestTestResult(db: OrcDb, sessionPk: string): TestResult | null {
  const r = db
    .select()
    .from(testResults)
    .where(eq(testResults.sessionPk, sessionPk))
    .orderBy(desc(testResults.ts))
    .get();
  return r ? toResult(r) : null;
}
