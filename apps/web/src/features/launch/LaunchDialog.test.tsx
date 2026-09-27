import { ApiRequestError, type TemplateDto } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { describeLaunchError, LaunchDialog } from './LaunchDialog.tsx';

const templates: TemplateDto[] = [
  {
    id: 'wf-implement-ticket',
    kind: 'workflow',
    label: 'Implement ticket',
    prompt: '/conductor {{ticketUrl}}',
    vars: ['ticketUrl'],
    defaultSource: 'claude',
    projectIds: 'all',
  },
  {
    id: 'preset-fix-ci',
    kind: 'preset',
    label: 'Fix CI failure',
    prompt: 'x',
    vars: ['prUrl', 'check'],
    defaultSource: 'claude',
    projectIds: 'all',
  },
];

const projects: Project[] = [
  {
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/Users/test/Wakecap'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 3,
  },
  {
    id: 'forza',
    name: 'Forza',
    pathPrefixes: ['/Users/test/Forza'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 1,
  },
];

const sessionsLaunch = vi.fn();
const openTerminal = vi.fn();

const api = () =>
  createFakeApi({
    sessionsLaunch,
    templatesList: vi.fn(async () => templates),
    projectsList: vi.fn(async () => projects),
  });

beforeEach(() => {
  sessionsLaunch.mockReset();
  openTerminal.mockReset();
  useProjectStore.setState({ projectId: 'wakecap' });
  useTerminalStore.setState({ open: openTerminal });
  useLaunchStore.setState({ open: true, preset: null });
});

afterEach(() => {
  cleanup();
  setApiClientForTests(null);
});

describe('LaunchDialog', () => {
  it('renders nothing when closed', () => {
    useLaunchStore.setState({ open: false, preset: null });
    renderWithProviders(<LaunchDialog />, { api: api() });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('launches a workflow template with its variables and opens the terminal', async () => {
    sessionsLaunch.mockResolvedValue({ ptyId: 'pty-3', sessionId: 's-9' });
    renderWithProviders(<LaunchDialog />, { api: api() });
    await screen.findByRole('dialog', { name: 'New session' });
    await screen.findByRole('option', { name: 'Implement ticket' });
    await vi.waitFor(() =>
      expect((screen.getByLabelText('Working directory') as HTMLInputElement).placeholder).toBe(
        '/Users/test/Wakecap',
      ),
    );
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'wf-implement-ticket' } });
    fireEvent.change(screen.getByLabelText('Ticket URL'), {
      target: { value: 'https://linear.app/x/issue/SAF-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await vi.waitFor(() =>
      expect(sessionsLaunch).toHaveBeenCalledWith({
        source: 'claude',
        projectId: 'wakecap',
        cwd: '/Users/test/Wakecap',
        prompt: '',
        templateId: 'wf-implement-ticket',
        vars: { ticketUrl: 'https://linear.app/x/issue/SAF-1' },
      }),
    );
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledWith('pty-3', 'Implement ticket'));
    expect(useLaunchStore.getState().open).toBe(false);
  });

  it('launches codex with a plain prompt, model and custom cwd', async () => {
    sessionsLaunch.mockResolvedValue({ ptyId: 'pty-4', sessionId: null });
    renderWithProviders(<LaunchDialog />, { api: api() });
    await screen.findByRole('dialog');
    await screen.findByRole('option', { name: 'Forza' });
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'forza' } });
    fireEvent.change(screen.getByLabelText('Working directory'), {
      target: { value: '/Users/test/Forza/app' },
    });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.5' } });
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'second opinion on the plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await vi.waitFor(() =>
      expect(sessionsLaunch).toHaveBeenCalledWith({
        source: 'codex',
        projectId: 'forza',
        cwd: '/Users/test/Forza/app',
        prompt: 'second opinion on the plan',
        vars: {},
        model: 'gpt-5.5',
      }),
    );
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledWith('pty-4', 'second opinion on the plan'));
  });

  it('sends the compare variants and opens the compare page', async () => {
    sessionsLaunch.mockResolvedValue({ compareGroupId: 'g-7' });
    const compareEstimate = vi.fn(async (_p: string | null, n: number) => ({
      variants: n,
      multiplier: n,
      avgSessionCostUsd: 1,
      estimatedUsd: n,
      sample: 3,
      burnRateUsdPerHour: 0,
      budget: { ok: true, pct: 0.1, limitUsd: null },
    }));
    const { router } = renderWithProviders(<LaunchDialog />, { api: { ...api(), compareEstimate } });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Opus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Codex' }));
    expect(await screen.findByText(/Runs 2 agents · 2× the cost/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await vi.waitFor(() =>
      expect(sessionsLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          compare: [{ source: 'claude', model: 'claude-opus-5' }, { source: 'codex' }],
        }),
      ),
    );
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/compare/g-7'));
    expect(openTerminal).not.toHaveBeenCalled();
    expect(useLaunchStore.getState().open).toBe(false);
  });

  it('shows server errors and stays open', async () => {
    sessionsLaunch.mockRejectedValue(
      new ApiRequestError(429, 'concurrency_limit', 'too many', {
        projectId: 'wakecap',
        max: 6,
        running: 6,
      }),
    );
    renderWithProviders(<LaunchDialog />, { api: api() });
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Concurrency limit reached: 6/6 app-owned sessions in this project.',
    );
    expect(useLaunchStore.getState().open).toBe(true);
    expect((screen.getByLabelText('Require plan approval first') as HTMLInputElement).disabled).toBe(false);
  });

  it('describes errors', () => {
    expect(
      describeLaunchError(
        new ApiRequestError(400, 'template_var_missing', 'x', { missing: ['prUrl', 'check'] }),
      ),
    ).toBe('Missing template fields: prUrl, check');
    expect(
      describeLaunchError(new ApiRequestError(501, 'not_implemented', 'plan approval arrives in phase 4')),
    ).toBe('Not available yet: plan approval arrives in phase 4');
    expect(describeLaunchError(new ApiRequestError(400, 'cwd_not_found', 'cwd does not exist'))).toBe(
      'cwd does not exist',
    );
    expect(describeLaunchError(new Error('boom'))).toBe('boom');
  });
});
