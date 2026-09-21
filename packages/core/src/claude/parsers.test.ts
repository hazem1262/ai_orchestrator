import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { AgentNode } from '../types/session.ts';
import { historyPromptsToSession, parseHistoryLine } from './history.ts';
import {
  isRegistryFileName,
  parseRegistryEntry,
  parseRegistryFile,
  registryStatusToLive,
} from './registry.ts';
import { createClaudeAggState, ingestClaudeRecord } from './session-aggregate.ts';
import {
  agentIdFromPath,
  buildAgentTree,
  claudeStateToAgentNode,
  parseSubagentMeta,
  unreachableAgentIds,
} from './subagents.ts';

const home = join(FIXTURES_DIR, 'claude-home');
const subDir = join(home, 'projects/-Users-test-Wakecap/s-subagents/subagents');
const resolve = () => ({ ticketRegex: null, prodPatterns: [] });

async function agentNode(agentId: string): Promise<AgentNode> {
  const path = join(subDir, `agent-${agentId}.jsonl`);
  const state = createClaudeAggState('s-subagents', agentId);
  for (const l of (await readJsonlFrom(path, 0)).lines)
    ingestClaudeRecord(state, parseJsonLine(l.text), resolve);
  const meta = parseSubagentMeta(
    JSON.parse(readFileSync(join(subDir, `agent-${agentId}.meta.json`), 'utf8')),
  );
  return claudeStateToAgentNode(state, meta, { sessionId: 's-subagents', agentId, transcriptPath: path });
}

describe('subagents', () => {
  it('reads agent ids from paths', () => {
    expect(agentIdFromPath('/x/subagents/agent-ag1.jsonl')).toBe('ag1');
    expect(agentIdFromPath('/x/subagents/agent-ag1.meta.json')).toBe('ag1');
    expect(agentIdFromPath('/x/s-basic.jsonl')).toBeNull();
  });

  it('parses meta with defaults', () => {
    expect(parseSubagentMeta(null)).toEqual({
      agentType: 'unknown',
      description: '',
      toolUseId: null,
      parentAgentId: null,
      spawnDepth: 1,
      background: false,
    });
  });

  it('builds a 3-level tree with the background flag', async () => {
    const nodes = await Promise.all(['ag3', 'ag1', 'ag2'].map(agentNode));
    const ag1 = nodes.find((n) => n.id === 'ag1');
    expect(ag1).toMatchObject({
      sessionId: 's-subagents',
      parentId: null,
      depth: 1,
      agentType: 'Explore',
      description: 'Explore logs',
      background: true,
      toolUseId: 'gtu1',
      startedAt: '2026-09-06T08:00:03.000Z',
      endedAt: '2026-09-06T08:00:10.000Z',
      status: 'done',
      usage: { input: 2, output: 3, cacheRead: 50, cacheWrite: 0, costUsd: null },
    });
    const tree = buildAgentTree(nodes);
    expect(tree.map((t) => t.node.id)).toEqual(['ag1']);
    expect(tree[0]?.children.map((t) => t.node.id)).toEqual(['ag2']);
    expect(tree[0]?.children[0]?.children.map((t) => [t.node.id, t.node.depth, t.node.background])).toEqual([
      ['ag3', 3, false],
    ]);
  });
});

describe('buildAgentTree cycles', () => {
  const cycleNode = (id: string, parentId: string | null): AgentNode => ({
    id,
    sessionId: 's-cycles',
    parentId,
    depth: 1,
    agentType: 'general-purpose',
    description: '',
    background: false,
    toolUseId: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    status: 'done',
    transcriptPath: '/x',
  });

  it('drops a self-cycle from the tree and reports it as unreachable', () => {
    const a = cycleNode('a', 'a');
    expect(buildAgentTree([a])).toEqual([]);
    expect(unreachableAgentIds([a])).toEqual(['a']);
  });

  it('drops a mutual a<->b cycle from the tree and reports both as unreachable', () => {
    const a = cycleNode('a', 'b');
    const b = cycleNode('b', 'a');
    expect(buildAgentTree([a, b])).toEqual([]);
    expect(unreachableAgentIds([a, b])).toEqual(['a', 'b']);
  });

  it('keeps a legitimate root+child intact alongside an unrelated 3-cycle', () => {
    const r = cycleNode('r', null);
    const ch = cycleNode('ch', 'r');
    const x = cycleNode('x', 'y');
    const y = cycleNode('y', 'z');
    const z = cycleNode('z', 'x');
    const nodes = [r, x, y, z, ch];

    const tree = buildAgentTree(nodes);
    expect(tree.map((t) => t.node.id)).toEqual(['r']);
    expect(tree[0]?.children.map((t) => t.node.id)).toEqual(['ch']);

    expect(unreachableAgentIds(nodes)).toEqual(['x', 'y', 'z']);
  });
});

describe('history.jsonl', () => {
  const prompts = readFileSync(join(home, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseHistoryLine(parseJsonLine(l)));

  it('parses lines with string or number timestamps', () => {
    expect(prompts[0]).toEqual({
      sessionId: 's-old-prompts-only',
      ts: '2025-12-25T08:06:40.000Z',
      display: 'old session from december',
      project: '/Users/test/Wakecap',
    });
    expect(
      parseHistoryLine({ display: 'x', timestamp: 1788253200000, project: '/p', sessionId: 's' })?.ts,
    ).toBe('2026-09-01T09:00:00.000Z');
    expect(parseHistoryLine({ display: 'x' })).toBeNull();
    expect(parseHistoryLine('nope')).toBeNull();
  });

  it('builds prompts-only sessions', () => {
    const basic = prompts.filter((p) => p?.sessionId === 's-basic').flatMap((p) => (p ? [p] : []));
    const s = historyPromptsToSession(basic, {
      projectId: 'wakecap',
      ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX),
    });
    expect(s).toMatchObject({
      id: 's-basic',
      source: 'claude',
      projectId: 'wakecap',
      startCwd: '/Users/test/Wakecap',
      name: 'check the notification service tests',
      firstPrompt: 'check the notification service tests',
      lastPrompt: 'continue',
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:05:00.000Z',
      promptCount: 2,
      availability: 'prompts-only',
      transcriptPath: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    });
    const stocks = prompts.filter((p) => p?.sessionId === 's-stocks').flatMap((p) => (p ? [p] : []));
    expect(historyPromptsToSession(stocks, { projectId: null, ticketRegex: null })).toMatchObject({
      startCwd: '/Users/test/Stocks/EGX Investment Research',
      skills: ['long-scan'],
      projectId: null,
    });
    expect(historyPromptsToSession([], { projectId: null, ticketRegex: null })).toBeNull();
  });
});

describe('registry', () => {
  // Canonical shape per plan/00-contracts.md §13 (controller ruling amending the task brief):
  // epoch-millis fields stay numbers, `status` is a closed union that is null when unrecognised,
  // and messagingSocketPath/peer* are never copied.
  it('parses a registry file without the messaging socket, keeping epoch fields numeric', () => {
    const raw: unknown = JSON.parse(readFileSync(join(home, 'sessions/41001.json'), 'utf8'));
    const e = parseRegistryFile(raw);
    expect(e).toEqual({
      pid: 41001,
      procStart: 'Mon Sep  1 09:00:00 2026',
      sessionId: 's-basic',
      cwd: '/Users/test/Wakecap',
      startedAt: 1788253200000,
      version: '2.1.273',
      kind: 'interactive',
      name: 'notification-tests',
      status: 'waiting',
      waitingFor: 'input needed',
      statusUpdatedAt: 1788253600000,
      updatedAt: 1788253600000,
    });
    expect(JSON.stringify(e)).not.toContain('cc-socks');
    expect(JSON.stringify(e)).not.toContain('messagingSocketPath');
    expect(JSON.stringify(e)).not.toContain('peer');
  });

  it('parseRegistryFile is the same function as parseRegistryEntry', () => {
    expect(parseRegistryFile).toBe(parseRegistryEntry);
  });

  it('returns null for malformed input instead of throwing (spike S3: non-atomic writes)', () => {
    expect(parseRegistryEntry({ pid: 'x' })).toBeNull();
    // truncated JSON, as a reader mid-write would produce via parseJsonLine
    expect(parseRegistryEntry(parseJsonLine('{"pid":41001,"sessionId":"s","cwd":"/x"'))).toBeNull();
    // non-object
    expect(parseRegistryEntry('nope')).toBeNull();
    expect(parseRegistryEntry(null)).toBeNull();
    expect(parseRegistryEntry(42)).toBeNull();
    // object missing pid
    expect(parseRegistryEntry({ sessionId: 's-basic', cwd: '/Users/test/Wakecap' })).toBeNull();
  });

  it('maps registry status to LiveStatus', () => {
    expect(registryStatusToLive('busy')).toBe('busy');
    expect(registryStatusToLive('waiting')).toBe('waiting');
    expect(registryStatusToLive('shell')).toBe('shell');
    expect(registryStatusToLive('something-new')).toBe('idle');
  });

  it('recognises registry file names and rejects .key lock files', () => {
    expect(isRegistryFileName('41001.json')).toBe(true);
    expect(isRegistryFileName('0.json')).toBe(true);
    expect(isRegistryFileName('41001.2e46b3c9.key')).toBe(false);
    expect(isRegistryFileName('41001.json.bak')).toBe(false);
    expect(isRegistryFileName('not-a-pid.json')).toBe(false);
  });
});
