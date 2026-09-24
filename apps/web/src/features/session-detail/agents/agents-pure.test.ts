import type { AgentNode } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { conductorChain, conductorStep, isConductorSession } from './conductor.ts';
import { defaultCollapsed, layoutAgentTree, ROOT_ID } from './layout.ts';

const agent = (p: Partial<AgentNode> & Pick<AgentNode, 'id'>): AgentNode => ({
  sessionId: 's-subagents',
  parentId: null,
  depth: 1,
  agentType: 'general-purpose',
  description: '',
  background: false,
  toolUseId: null,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null },
  startedAt: '2026-09-06T08:00:03.000Z',
  endedAt: '2026-09-06T08:00:20.000Z',
  status: 'done',
  transcriptPath: `/x/agent-${p.id}.jsonl`,
  ...p,
});

const tree = (leafStatus: AgentNode['status']) => [
  agent({ id: 'ag1', agentType: 'Explore', description: 'Explore logs', background: true }),
  agent({ id: 'ag2', parentId: 'ag1', depth: 2, description: 'Deep dive' }),
  agent({
    id: 'ag3',
    parentId: 'ag2',
    depth: 3,
    description: 'Leaf',
    status: leafStatus,
    endedAt: leafStatus === 'running' ? null : '2026-09-06T08:00:20.000Z',
  }),
];

describe('conductorStep', () => {
  it.each([
    [{ agentType: 'repo-resolver', description: '' }, 'repo-resolver'],
    [{ agentType: 'conductor:lint', description: '' }, 'lint'],
    [{ agentType: 'test-agent', description: '' }, 'test'],
    [{ agentType: 'general-purpose', description: 'Create feature branch for SAF-1787' }, 'branch'],
    [{ agentType: 'general-purpose', description: 'Implement the SLA change' }, 'code'],
    [{ agentType: 'general-purpose', description: 'Run lint and build' }, 'lint'],
    [{ agentType: 'general-purpose', description: 'Run the unit tests' }, 'test'],
    [{ agentType: 'general-purpose', description: 'Build the service' }, 'build'],
    [
      { agentType: 'general-purpose', description: 'Visual verify with playwright screenshot' },
      'visual-verify',
    ],
    [{ agentType: 'Explore', description: 'Explore logs' }, null],
  ] as const)('%j → %s', (a, step) => {
    expect(conductorStep(a)).toBe(step);
  });
});

describe('conductorChain', () => {
  const agents = [
    agent({ id: 'c1', agentType: 'repo-resolver' }),
    agent({ id: 'c2', description: 'create branch' }),
    agent({ id: 'c3', description: 'implement code', status: 'running', endedAt: null }),
    agent({ id: 'c4', description: 'run tests', status: 'error' }),
  ];

  it('returns null when not a conductor session or too few agents map', () => {
    expect(conductorChain(agents, { isConductor: false })).toBeNull();
    expect(conductorChain(tree('done'), { isConductor: true })).toBeNull();
  });

  it('orders steps and derives status', () => {
    const chain = conductorChain(agents, { isConductor: true });
    expect(chain?.map((s) => [s.step, s.status, s.agents.map((a) => a.id)])).toEqual([
      ['repo-resolver', 'done', ['c1']],
      ['branch', 'done', ['c2']],
      ['code', 'running', ['c3']],
      ['lint', 'pending', []],
      ['test', 'error', ['c4']],
      ['build', 'pending', []],
      ['visual-verify', 'pending', []],
    ]);
  });

  it('detects conductor sessions from skills', () => {
    expect(isConductorSession(['review', 'conductor'])).toBe(true);
    expect(isConductorSession(['wstack:conductor'])).toBe(true);
    expect(isConductorSession(['review'])).toBe(false);
  });
});

describe('defaultCollapsed', () => {
  it('keeps running/error branches expanded and collapses finished ones', () => {
    expect([...defaultCollapsed(tree('running'))]).toEqual([]);
    expect([...defaultCollapsed(tree('error'))]).toEqual([]);
    expect([...defaultCollapsed(tree('done'))].sort()).toEqual(['ag1', 'ag2']);
  });
});

describe('layoutAgentTree', () => {
  it('places depth on x and leaves on rows', () => {
    const { nodes, edges } = layoutAgentTree(tree('running'), new Set(), 's-subagents');
    const pos = Object.fromEntries(nodes.map((n) => [n.id, [n.position.x, n.position.y]]));
    expect(pos).toEqual({ [ROOT_ID]: [0, 0], ag1: [300, 0], ag2: [600, 0], ag3: [900, 0] });
    expect(edges.map((e) => [e.source, e.target, e.animated])).toEqual([
      [ROOT_ID, 'ag1', false],
      ['ag1', 'ag2', false],
      ['ag2', 'ag3', true],
    ]);
    expect(nodes.find((n) => n.id === ROOT_ID)?.data.label).toBe('s-subagents');
    expect(nodes.find((n) => n.id === 'ag1')?.data.label).toBe('Explore logs');
  });

  it('hides collapsed descendants and centers parents', () => {
    const agents = [...tree('done'), agent({ id: 'ag4', description: 'Other' })];
    const { nodes, edges } = layoutAgentTree(agents, new Set(['ag1']), 'root');
    expect(nodes.map((n) => n.id).sort()).toEqual(['ag1', 'ag4', ROOT_ID]);
    expect(edges).toHaveLength(2);
    const ag1 = nodes.find((n) => n.id === 'ag1');
    expect(ag1?.data).toMatchObject({ collapsed: true, childCount: 1 });
    expect(nodes.find((n) => n.id === ROOT_ID)?.position.y).toBe(48);
  });

  it('attaches orphans to the root', () => {
    const { edges } = layoutAgentTree([agent({ id: 'x', parentId: 'missing' })], new Set(), 'root');
    expect(edges.map((e) => e.source)).toEqual([ROOT_ID]);
  });
});
