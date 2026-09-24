import type { SessionStatsResponse } from '@orc/api-contract';
import type { TimelineEvent, TurnDeliverables } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionDeliverables, useSessionStats } from '@/api/queries/session-detail';
import { useSessionEvents } from '@/api/queries/sessions';
import { useViewModeStore } from '@/stores/view-mode';
import { renderP3 } from '@/test/p3-render';
import { TrajectoryTimeline } from './TrajectoryTimeline.tsx';

vi.mock('@/api/queries/sessions', () => ({ useSessionEvents: vi.fn() }));
vi.mock('@/api/queries/session-detail', () => ({
  useSessionStats: vi.fn(),
  useSessionDeliverables: vi.fn(),
}));

const base = {
  sessionId: 's-basic',
  agentId: null,
  parentUuid: null,
  turn: 1,
  text: null,
  tool: null,
  toolUseId: null,
  mcpServer: null,
  input: null,
  messageId: null,
  model: null,
  usage: null,
  durationMs: null,
};
const events: TimelineEvent[] = [
  {
    ...base,
    uuid: 'u1',
    seq: 1,
    ts: '2026-09-01T09:00:00.000Z',
    kind: 'prompt',
    text: 'check the notification service tests',
  },
  {
    ...base,
    uuid: 'a1',
    seq: 2,
    ts: '2026-09-01T09:00:05.000Z',
    kind: 'tool_call',
    tool: 'Bash',
    toolUseId: 'tu1',
    input: { command: 'pnpm vitest run' },
    model: 'claude-opus-5',
    usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null },
  },
  {
    ...base,
    uuid: 'u2',
    seq: 3,
    ts: '2026-09-01T09:00:30.000Z',
    kind: 'tool_result',
    toolUseId: 'tu1',
    text: 'Tests 18 passed (18)',
  },
  { ...base, uuid: 'a2', seq: 4, ts: '2026-09-01T09:00:35.000Z', kind: 'thinking', text: 'secret plan' },
];
const turnStats = {
  turn: 1,
  agentId: null,
  startedAt: '',
  endedAt: '',
  wallMs: 36000,
  modelMs: 10800,
  toolMs: 25200,
  reportedMs: 36000,
  ttftMs: 5000,
  toolCalls: 1,
  toolErrors: 0,
  apiErrors: 0,
  usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null },
  tokensPerSec: 2.5,
  cacheHitRate: 0.9,
};
const stats: SessionStatsResponse = { session: { ...turnStats, turns: 1 }, turns: [turnStats], agents: [] };
const deliverables: TurnDeliverables[] = [
  {
    turn: 1,
    agentId: null,
    files: [
      {
        path: '/Users/test/Wakecap/Backend/svc/a.ts',
        tools: ['Edit'],
        ops: 1,
        status: 'applied',
        lastTs: '',
      },
    ],
  },
];

beforeEach(() => {
  useViewModeStore.setState({ mode: 'normal' });
  vi.mocked(useSessionEvents).mockReturnValue({
    data: { pages: [{ items: events, nextSeq: null }], pageParams: [0] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  } as unknown as ReturnType<typeof useSessionEvents>);
  vi.mocked(useSessionStats).mockReturnValue({ data: stats } as unknown as ReturnType<
    typeof useSessionStats
  >);
  vi.mocked(useSessionDeliverables).mockReturnValue({ data: deliverables } as unknown as ReturnType<
    typeof useSessionDeliverables
  >);
});

describe('TrajectoryTimeline', () => {
  it('renders prompts as headers with stats, grouped tools and deliverables', async () => {
    const onOpenFile = vi.fn();
    renderP3(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={onOpenFile} />);
    expect(screen.getByRole('heading', { name: 'check the notification service tests' })).toBeDefined();
    expect(screen.getByTestId('turn-stats').textContent).toBe(
      'model 10.8s · tools 25.2s · TTFT ≈5.0s · 2.5 tok/s · cache 90%',
    );
    expect(screen.getByRole('button', { name: 'Bash ×1' })).toBeDefined();
    expect(screen.queryByText('secret plan')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /…\/svc\/a\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith('/Users/test/Wakecap/Backend/svc/a.ts');
  });

  it('opens the step inspector from an expanded group', async () => {
    renderP3(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Bash ×1' }));
    await userEvent.click(screen.getByRole('button', { name: 'pnpm vitest run' }));
    const inspector = screen.getByRole('complementary', { name: 'Step inspector' });
    expect(inspector.textContent).toContain('25.0s');
    expect(inspector.textContent).toContain('claude-opus-5');
    expect(screen.getByTestId('step-input').textContent).toContain('"command": "pnpm vitest run"');
    expect(screen.getByTestId('step-output').textContent).toBe('Tests 18 passed (18)');
    await userEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Step inspector' })).toBeNull();
  });

  it('hides tools in summary mode and shows thinking in verbose mode', () => {
    useViewModeStore.setState({ mode: 'summary' });
    const { rerender } = renderP3(
      <TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Bash ×1' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Deliverables' })).toBeDefined();
    useViewModeStore.setState({ mode: 'verbose' });
    rerender(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText('secret plan')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Bash: pnpm vitest run' })).toBeDefined();
  });
});
