import type { TestResult } from '../types/session.ts';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|dotnet\s+test|flutter\s+test)\b|\b(?:pnpm|npm|yarn|bun)\b[^\n|;&]*\btest\b/;

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}
type Parser = (out: string) => Counts | null;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

function toMs(value: string | undefined, unit: string | undefined): number {
  const n = Number(value ?? 0);
  if (unit === 'ms') return Math.round(n);
  if (unit === 'm') return Math.round(n * 60_000);
  return Math.round(n * 1000);
}

function countWords(s: string): Omit<Counts, 'durationMs'> {
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const m of s.matchAll(/(\d+)\s+(passed|failed|skipped|todo|errors?)\b/g)) {
    const n = Number(m[1]);
    const word = m[2];
    if (word === 'passed') c.passed += n;
    else if (word === 'failed' || word === 'error' || word === 'errors') c.failed += n;
    else c.skipped += n;
  }
  return c;
}

const parseVitest: Parser = (out) => {
  const line = /^\s*Tests\s+(\d+\s+(?:passed|failed|skipped|todo)\b.*)$/m.exec(out);
  if (!line?.[1]) return null;
  const d = /^\s*Duration\s+([\d.]+)\s*(ms|s)\b/m.exec(out);
  return { ...countWords(line[1]), durationMs: d ? toMs(d[1], d[2]) : null };
};

const parseJest: Parser = (out) => {
  const line = /^Tests:\s+(.+)$/m.exec(out);
  if (!line?.[1]) return null;
  const t = /^Time:\s+([\d.]+)\s*(ms|s)\b/m.exec(out);
  return { ...countWords(line[1]), durationMs: t ? toMs(t[1], t[2]) : null };
};

const parseDotnet: Parser = (out) => {
  const re =
    /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+\d+(?:,\s+Duration:\s+([\d.]+)\s*(ms|s|m)\b)?/g;
  let found = false;
  let durationMs = 0;
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const m of out.matchAll(re)) {
    found = true;
    c.failed += Number(m[1]);
    c.passed += Number(m[2]);
    c.skipped += Number(m[3]);
    if (m[4]) durationMs += toMs(m[4], m[5]);
  }
  return found ? { ...c, durationMs: durationMs || null } : null;
};

const parseFlutter: Parser = (out) => {
  const last = [...out.matchAll(/(\d+):(\d+)\s+\+(\d+)(?:\s+~(\d+))?(?:\s+-(\d+))?:/g)].at(-1);
  if (!last) return null;
  return {
    passed: Number(last[3]),
    skipped: Number(last[4] ?? 0),
    failed: Number(last[5] ?? 0),
    durationMs: (Number(last[1]) * 60 + Number(last[2])) * 1000,
  };
};

const parsePytest: Parser = (out) => {
  const m = /^=+\s+(.*?\b(?:passed|failed|errors?|skipped)\b.*?)\s+in\s+([\d.]+)s\b.*=+\s*$/m.exec(out);
  if (!m?.[1]) return null;
  return { ...countWords(m[1]), durationMs: toMs(m[2], 's') };
};

function parsersFor(command: string): Parser[] {
  if (/\bflutter\b/.test(command)) return [parseFlutter];
  if (/\bdotnet\b/.test(command)) return [parseDotnet];
  if (/\bpytest\b/.test(command)) return [parsePytest];
  if (/\bjest\b/.test(command)) return [parseJest];
  return [parseVitest, parseJest, parsePytest, parseDotnet, parseFlutter];
}

export function parseTestOutput(command: string, output: string, ts: string): TestResult | null {
  const clean = output.replace(ANSI, '');
  for (const parse of parsersFor(command)) {
    const c = parse(clean);
    if (c && c.passed + c.failed + c.skipped > 0) {
      return {
        ts,
        command,
        passed: c.passed,
        failed: c.failed,
        skipped: c.skipped,
        durationMs: c.durationMs,
      };
    }
  }
  return null;
}
