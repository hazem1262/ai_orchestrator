import type { SessionLinks, UsagePoint } from '@orc/api-contract';
import type { FileSummary, Session } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlanContent } from '@/api/queries/safety';
import {
  useSessionAgents,
  useSessionFiles,
  useSessionLinks,
  useSessionRaw,
  useSessionStats,
  useSessionUsageSeries,
} from '@/api/queries/session-detail';
import { renderP3 } from '@/test/p3-render';
import { FilesTab } from './FilesTab.tsx';
import { LinksTab } from './LinksTab.tsx';
import { RawTab } from './RawTab.tsx';
import { SessionDetailTabs } from './SessionDetailTabs.tsx';
import { UsageTab } from './UsageTab.tsx';

const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
vi.mock('@/api/queries/session-detail', () => ({
  useSessionAgents: vi.fn(),
  useSessionUsageSeries: vi.fn(),
  useSessionFiles: vi.fn(),
  useSessionLinks: vi.fn(),
  useSessionRaw: vi.fn(),
  useSessionStats: vi.fn(),
}));
vi.mock('@/api/queries/safety', () => ({ usePlanContent: vi.fn() }));
vi.mock('../timeline/TrajectoryTimeline.tsx', () => ({
  TrajectoryTimeline: (p: { agentId: string | null; onOpenFile: (f: string) => void }) => (
    <button type="button" onClick={() => p.onOpenFile('/r/a.ts')}>
      timeline:{p.agentId ?? 'main'}
    </button>
  ),
}));
vi.mock('../agents/AgentsTree.tsx', () => ({
  AgentsTree: (p: { onOpenAgent: (id: string | null) => void }) => (
    <button type="button" onClick={() => p.onOpenAgent('ag2')}>
      tree
    </button>
  ),
}));

const q = <T,>(data: T) => ({ data, isLoading: false, isError: false }) as never;

const usage: UsagePoint[] = [
  {
    ts: '2026-09-01T09:00:05.000Z',
    agentId: null,
    model: 'claude-opus-5',
    input: 10,
    output: 20,
    cacheRead: 1000,
    cacheWrite: 100,
    costUsd: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSessionAgents).mockReturnValue(q([]));
  vi.mocked(useSessionStats).mockReturnValue(q(undefined));
});

describe('UsageTab', () => {
  it('draws token charts when no cost is known and disposes on unmount', () => {
    vi.mocked(useSessionUsageSeries).mockReturnValue(q(usage));
    const { unmount } = renderP3(<UsageTab source="claude" id="s-basic" />);
    expect(screen.getByRole('radio', { name: 'Cost' }).hasAttribute('disabled')).toBe(true);
    const option = chart.setOption.mock.calls[0]?.[0] as { yAxis: Array<{ name?: string }> };
    expect(option.yAxis[0]?.name).toBe('tokens');
    expect(screen.getByTestId('usage-totals').textContent).toBe(
      'cache read 1.0k · cache write 100 · input 10 · output 20 · cache hit 90%',
    );
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });
});

describe('FilesTab', () => {
  const files: FileSummary[] = [
    {
      path: '/Users/test/Wakecap/Backend/svc/a.ts',
      ops: 2,
      failedOps: 1,
      turns: [1, 2],
      agentIds: [null, 'ag1'],
      firstTs: '2026-09-01T09:00:35.000Z',
      lastTs: '2026-09-01T09:05:00.000Z',
      changes: [
        {
          path: '/Users/test/Wakecap/Backend/svc/a.ts',
          tool: 'Edit',
          toolUseId: 'tu2',
          turn: 1,
          seq: 4,
          ts: '2026-09-01T09:00:35.000Z',
          agentId: null,
          status: 'applied',
          oldText: 'old line',
          newText: 'new line',
        },
      ],
    },
  ];

  it('lists files relative to the start cwd and shows edit snippets for the selection', async () => {
    vi.mocked(useSessionFiles).mockReturnValue(q(files));
    const onSelect = vi.fn();
    const { rerender } = renderP3(
      <FilesTab
        source="claude"
        id="s-basic"
        startCwd="/Users/test/Wakecap"
        selectedPath={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Backend/svc/a.ts' }));
    expect(onSelect).toHaveBeenCalledWith('/Users/test/Wakecap/Backend/svc/a.ts');
    expect(screen.getByRole('row', { name: /Backend\/svc\/a\.ts 2 1 1, 2 main, ag1/ })).toBeDefined();
    rerender(
      <FilesTab
        source="claude"
        id="s-basic"
        startCwd="/Users/test/Wakecap"
        selectedPath="/Users/test/Wakecap/Backend/svc/a.ts"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId('change-old').textContent).toBe('old line');
    expect(screen.getByTestId('change-new').textContent).toBe('new line');
  });
});

describe('LinksTab', () => {
  const links: SessionLinks = {
    prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
    tickets: [{ id: 'SAF-1787', url: 'https://linear.app/acme/issue/SAF-1787' }],
    plans: [
      {
        path: '/p/SAF-1787.md',
        title: 'SLA plan',
        source: 'wakecap-plans',
        mtime: '2026-09-01T00:00:00.000Z',
        reason: 'ticket',
        tickets: ['SAF-1787'],
      },
    ],
    artifacts: [{ title: 'Artifact', url: 'https://example.test/a', path: null }],
    bridgeSessionId: 'b-1',
  };

  it('shows every link kind and opens plan content', async () => {
    vi.mocked(useSessionLinks).mockReturnValue(q(links));
    vi.mocked(usePlanContent).mockImplementation((path) =>
      q(path ? { path, text: '# SLA plan body' } : undefined),
    );
    renderP3(<LinksTab source="claude" id="s-prlink" />);
    expect(screen.getByRole('link', { name: 'example-org/svc#231' }).getAttribute('href')).toBe(
      'https://github.com/example-org/svc/pull/231',
    );
    expect(screen.getByRole('link', { name: 'SAF-1787' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Artifact' })).toBeDefined();
    expect(screen.getByText('b-1')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'SLA plan' }));
    expect(screen.getByTestId('plan-content').textContent).toBe('# SLA plan body');
  });
});

describe('RawTab', () => {
  it('lists lines, switches agent and loads more', async () => {
    const fetchNextPage = vi.fn();
    vi.mocked(useSessionRaw).mockReturnValue({
      data: {
        pages: [
          {
            path: '/x',
            items: [
              { offset: 0, text: '{"type":"user"}', truncated: false, partial: false },
              { offset: 16, text: '{"type":', truncated: false, partial: true },
            ],
            nextOffset: 30,
          },
        ],
        pageParams: [0],
      },
      isLoading: false,
      isError: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    } as never);
    const agents = [{ id: 'ag1', description: 'Explore logs', agentType: 'Explore' }] as never;
    renderP3(<RawTab source="claude" id="s-basic" agents={agents} />);
    expect(screen.getByText('{"type":"user"}')).toBeDefined();
    expect(screen.getByText('partial')).toBeDefined();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Transcript' }), 'ag1');
    expect(vi.mocked(useSessionRaw)).toHaveBeenLastCalledWith('claude', 's-basic', 'ag1');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(fetchNextPage).toHaveBeenCalled();
  });
});

describe('SessionDetailTabs', () => {
  const session = {
    id: 's-subagents',
    source: 'claude',
    startCwd: '/Users/test/Wakecap',
    name: 's-subagents',
    skills: [],
  } as unknown as Session;

  it('navigates between tabs and from agents to the agent timeline', async () => {
    const onNavigate = vi.fn();
    const { rerender } = renderP3(
      <SessionDetailTabs
        session={session}
        tab="timeline"
        agentId={null}
        file={null}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'timeline:main' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'files', file: '/r/a.ts' });
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'agents' });
    rerender(
      <SessionDetailTabs session={session} tab="agents" agentId={null} file={null} onNavigate={onNavigate} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'tree' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'timeline', agent: 'ag2' });
    rerender(
      <SessionDetailTabs
        session={session}
        tab="timeline"
        agentId="ag2"
        file={null}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole('button', { name: 'timeline:ag2' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Back to main session' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ agent: null });
  });
});
