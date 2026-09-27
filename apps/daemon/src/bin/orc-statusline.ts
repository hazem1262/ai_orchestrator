#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UsageSnapshot } from '@orc/core';

export interface StatuslineInput {
  session_id?: string;
  cost?: { total_cost_usd?: number };
  model?: { id?: string; display_name?: string };
}
export interface StatuslineLive {
  id: string;
  source: string;
  usage?: { costUsd: number | null };
  live: { status: string; contextFill: number | null } | null;
}
export interface StatuslineData {
  usage: UsageSnapshot | null;
  live: StatuslineLive[] | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatStatusline(input: StatuslineInput, data: StatuslineData): string {
  const parts: string[] = [];
  const mine = data.live?.find((s) => s.source === 'claude' && s.id === input.session_id) ?? null;
  const cost = input.cost?.total_cost_usd ?? mine?.usage?.costUsd ?? null;
  if (cost !== null && cost !== undefined) parts.push(usd(cost));
  if (data.usage === null || data.live === null) {
    parts.push('orc offline');
    return parts.join(' · ');
  }
  if (mine?.live?.contextFill !== null && mine?.live?.contextFill !== undefined)
    parts.push(`ctx ${pct(mine.live.contextFill)}`);
  const u = data.usage;
  const est = u.source === 'estimate' ? ' est' : '';
  if (u.block.active) {
    parts.push(
      u.block.pctOfLimit !== null
        ? `5h ${pct(u.block.pctOfLimit)}${est}`
        : `5h ${usd(u.block.costUsd)}${est}`,
    );
    parts.push(`${usd(u.burnRateUsdPerHour)}/h`);
  }
  const waiting = data.live.filter((s) => s.live?.status === 'waiting').length;
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.join(' · ');
}

async function getJson<T>(f: typeof fetch, url: string, token: string): Promise<T | null> {
  try {
    const res = await f(url, { headers: { 'x-orc-token': token }, signal: AbortSignal.timeout(800) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function defaultReadToken(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export async function runStatusline(o: {
  stdin: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readToken?: (file: string) => string | null;
}): Promise<string> {
  let input: StatuslineInput = {};
  try {
    input = JSON.parse(o.stdin) as StatuslineInput;
  } catch {
    input = {};
  }
  const f = o.fetchImpl ?? fetch;
  const orcHome = o.env.ORC_HOME ?? join(homedir(), '.orchestrator');
  const base = `http://127.0.0.1:${o.env.ORC_PORT ?? '4317'}`;
  const token = (o.readToken ?? defaultReadToken)(join(orcHome, 'token'));
  if (!token) return formatStatusline(input, { usage: null, live: null });
  await f(`${base}/api/usage/official`, {
    method: 'POST',
    headers: { 'x-orc-token': token, 'content-type': 'application/json' },
    body: o.stdin,
    signal: AbortSignal.timeout(300),
  }).catch(() => null);
  const [usage, live] = await Promise.all([
    getJson<UsageSnapshot>(f, `${base}/api/usage`, token),
    getJson<StatuslineLive[]>(f, `${base}/api/live`, token),
  ]);
  return formatStatusline(input, { usage, live });
}

async function main(): Promise<void> {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += String(chunk);
  process.stdout.write(`${await runStatusline({ stdin, env: process.env })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.stdout.write('orc offline\n'));
}
