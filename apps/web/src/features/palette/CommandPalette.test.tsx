import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaletteStore } from '@/stores/palette';
import { useProjectStore } from '@/stores/project';
import { stubReactFlowDom } from '@/test/flow-stubs';
import { renderP3 } from '@/test/p3-render';
import { CommandPalette } from './CommandPalette.tsx';

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  openLaunch: vi.fn(),
  openTerminal: vi.fn(),
  sessionsList: vi.fn(),
  sessionsResume: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));
vi.mock('@/stores/launch', () => ({
  useLaunchStore: (sel: (s: { show: typeof m.openLaunch }) => unknown) => sel({ show: m.openLaunch }),
}));
vi.mock('@/stores/terminals', () => ({ useTerminalStore: { getState: () => ({ open: m.openTerminal }) } }));
vi.mock('@/api/client', () => ({
  getApiClient: () => ({ sessionsList: m.sessionsList, sessionsResume: m.sessionsResume }),
}));
vi.mock('@/api/queries/sessions', () => ({
  useSessions: () => ({
    data: {
      items: [
        {
          source: 'claude',
          id: 's-prlink',
          name: 'SAF-1787 SLA weekends',
          firstPrompt: null,
          projectId: 'wakecap',
          tickets: ['SAF-1787'],
          prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
        },
      ],
      nextCursor: null,
    },
  }),
}));
vi.mock('@/api/queries/projects', () => ({
  useProjects: () => ({ data: [{ id: 'wakecap', name: 'Wakecap' }] }),
}));
vi.mock('@/api/queries/templates', () => ({
  useTemplates: () => ({ data: [{ id: 'implement', label: 'Implement ticket' }] }),
}));
vi.mock('@/api/queries/safety', () => ({
  usePlans: () => ({
    data: [
      {
        path: '/p/SAF-1787.md',
        title: 'SLA plan',
        source: 'wakecap-plans',
        mtime: '',
        reason: 'query',
        tickets: ['SAF-1787'],
      },
    ],
  }),
  usePlanContent: (path: string | null) => ({ data: path ? { path, text: '# SLA plan body' } : undefined }),
}));

beforeAll(() => {
  stubReactFlowDom();
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projectId: 'wakecap' });
  act(() => usePaletteStore.setState({ open: true }));
});

const item = (name: string | RegExp) => screen.getByRole('option', { name });

describe('CommandPalette', () => {
  it('navigates and closes', async () => {
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Open inbox/));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/inbox', search: undefined });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('jumps to a session found by ticket keyword', async () => {
    renderP3(<CommandPalette />);
    await userEvent.type(screen.getByRole('combobox'), 'SAF-1787');
    await userEvent.click(item(/SAF-1787 SLA weekends/));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/sessions/claude/s-prlink', search: undefined });
  });

  it('resumes the last session in a project into the terminal dock', async () => {
    m.sessionsList.mockResolvedValue({
      items: [{ source: 'claude', id: 's-basic', name: 'notification-tests' }],
      nextCursor: null,
    });
    m.sessionsResume.mockResolvedValue({ ptyId: 'p1' });
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Resume last session in Wakecap/));
    await waitFor(() => expect(m.openTerminal).toHaveBeenCalledWith('p1', 'notification-tests'));
    expect(m.sessionsList).toHaveBeenCalledWith({
      projectId: 'wakecap',
      availability: 'resumable',
      limit: 1,
    });
    expect(m.sessionsResume).toHaveBeenCalledWith('claude', 's-basic', { mode: 'embedded' });
  });

  it('shows an error when there is nothing to resume', async () => {
    m.sessionsList.mockResolvedValue({ items: [], nextCursor: null });
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Resume last session in Wakecap/));
    expect((await screen.findByRole('alert')).textContent).toBe('No resumable session in this project');
  });

  it('opens the launch dialog with a template', async () => {
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Launch: Implement ticket/));
    expect(m.openLaunch).toHaveBeenCalledWith({ templateId: 'implement', projectId: 'wakecap' });
  });

  it('previews a plan and opens PRs in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderP3(<CommandPalette />);
    await userEvent.click(item(/example-org\/svc#231/));
    expect(open).toHaveBeenCalledWith('https://github.com/example-org/svc/pull/231', '_blank', 'noopener');
    act(() => usePaletteStore.setState({ open: true }));
    await userEvent.click(item(/SLA plan/));
    expect(screen.getByTestId('palette-plan').textContent).toBe('# SLA plan body');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('combobox')).toBeDefined();
  });
});
