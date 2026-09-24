import type { AgentNode } from '@orc/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stubReactFlowDom } from '@/test/flow-stubs';
import { AgentsTree } from './AgentsTree.tsx';
import { ConductorChain } from './ConductorChain.tsx';
import { conductorChain } from './conductor.ts';

beforeAll(() => stubReactFlowDom());

const agent = (p: Partial<AgentNode> & Pick<AgentNode, 'id'>): AgentNode => ({
  sessionId: 's-subagents',
  parentId: null,
  depth: 1,
  agentType: 'general-purpose',
  description: '',
  background: false,
  toolUseId: null,
  usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.12 },
  startedAt: '2026-09-06T08:00:03.000Z',
  endedAt: '2026-09-06T08:00:20.000Z',
  status: 'done',
  transcriptPath: '/x.jsonl',
  ...p,
});

const done = [
  agent({ id: 'ag1', agentType: 'Explore', description: 'Explore logs', background: true }),
  agent({ id: 'ag2', parentId: 'ag1', depth: 2, description: 'Deep dive' }),
  agent({ id: 'ag3', parentId: 'ag2', depth: 3, description: 'Leaf' }),
];

describe('AgentsTree', () => {
  it('renders nodes and collapses finished branches in the outline', async () => {
    const onOpenAgent = vi.fn();
    render(<AgentsTree agents={done} rootLabel="s-subagents" onOpenAgent={onOpenAgent} />);
    expect(await screen.findByTestId('agent-node-ag1')).toBeDefined();
    const outline = screen.getByRole('tree', { name: 'Agents outline' });
    expect(outline.textContent).toContain('Explore logs');
    expect(screen.queryByRole('button', { name: 'Open Deep dive' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Expand Explore logs' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Deep dive' }));
    expect(onOpenAgent).toHaveBeenCalledWith('ag2');
  });

  it('starts running branches expanded', () => {
    const running = done.map((a) =>
      a.id === 'ag3' ? { ...a, status: 'running' as const, endedAt: null } : a,
    );
    render(<AgentsTree agents={running} rootLabel="s-subagents" onOpenAgent={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open Leaf' })).toBeDefined();
  });
});

describe('ConductorChain', () => {
  it('renders steps in order with status and agent links', async () => {
    const chain = conductorChain(
      [
        agent({ id: 'c1', agentType: 'repo-resolver', description: 'Resolve repo' }),
        agent({ id: 'c2', description: 'run tests', status: 'error' }),
      ],
      { isConductor: true },
    );
    if (!chain) throw new Error('expected chain');
    const onOpenAgent = vi.fn();
    render(<ConductorChain chain={chain} onOpenAgent={onOpenAgent} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual([
      'done',
      'pending',
      'pending',
      'pending',
      'error',
      'pending',
      'pending',
    ]);
    expect(steps[0]?.textContent).toContain('1. repo-resolver');
    await userEvent.click(screen.getByRole('button', { name: 'run tests' }));
    expect(onOpenAgent).toHaveBeenCalledWith('c2');
  });
});
