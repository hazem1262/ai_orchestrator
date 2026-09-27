import type { SupervisorDecisionView, SupervisorStatus, SupervisorTarget } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { liveSessionFixture } from '@/test/factories.ts';
import { fakeApi, renderP3 as renderWithClient } from '@/test/p3-render.tsx';
import { DecisionsLog } from './DecisionsLog.tsx';
import { SupervisorSettings } from './SupervisorSettings.tsx';
import { SupervisorToggle } from './SupervisorToggle.tsx';

const status: SupervisorStatus = {
  enabled: true,
  quiet: false,
  model: 'claude-haiku-4-5',
  confidenceThreshold: 0.85,
  maxPerSessionPerHour: 3,
  maxPerHour: 10,
  quietHours: null,
  answeredLastHour: 2,
  escalatedLastHour: 1,
  monthCostUsd: 0.42,
  monthBudgetUsd: 5,
};

const decision: SupervisorDecisionView = {
  id: 'd1',
  sessionPk: 'claude:s1',
  projectId: 'wakecap',
  question: 'Should I continue?',
  decision: 'answer',
  answer: 'Yes, continue.',
  confidence: 0.93,
  reason: 'routine continue',
  intent: 'continue',
  sent: true,
  costUsd: 0.002,
  model: 'claude-haiku-4-5',
  feedback: null,
  ts: '2026-09-18T09:00:00.000Z',
};

afterEach(() => setApiClientForTests(null));

function api(over: Record<string, unknown> = {}) {
  const stubs = {
    supervisorStatus: vi.fn(async () => status),
    supervisorSettings: vi.fn(async () => ({ ...status, enabled: false })),
    supervisorTargets: vi.fn(
      async (): Promise<SupervisorTarget[]> => [
        { targetType: 'project', targetId: 'wakecap', enabled: true },
      ],
    ),
    supervisorSetTarget: vi.fn(async (t: SupervisorTarget) => t),
    supervisorRules: vi.fn(async () => []),
    supervisorAddRule: vi.fn(),
    supervisorDeleteRule: vi.fn(),
    supervisorDecisions: vi.fn(async () => [decision]),
    supervisorMarkWrong: vi.fn(async () => ({
      id: 'r1',
      projectId: null,
      kind: 'deny' as const,
      pattern: 'should\\s+i',
      intent: null,
      answer: null,
      source: 'feedback' as const,
      enabled: true,
      note: null,
      createdAt: 't',
    })),
    projectsList: vi.fn(async () => [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: ['/x'],
        hidden: false,
        lastActivityAt: null,
        sessionCount: 0,
      },
    ]),
    ...over,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('SupervisorSettings', () => {
  it('shows the status and turns the supervisor off', async () => {
    const stubs = api();
    renderWithClient(<SupervisorSettings />);
    expect(await screen.findByText(/2 answered · 1 escalated in the last hour/)).toBeTruthy();
    expect(screen.getByText('$0.42 of $5.00 this month')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Supervisor enabled' }));
    await waitFor(() => expect(stubs.supervisorSettings).toHaveBeenCalledWith({ enabled: false }));
    fireEvent.change(screen.getByLabelText('Confidence threshold'), { target: { value: '0.9' } });
    fireEvent.blur(screen.getByLabelText('Confidence threshold'));
    await waitFor(() => expect(stubs.supervisorSettings).toHaveBeenCalledWith({ confidenceThreshold: 0.9 }));
  });

  it('turns the supervisor on for a project', async () => {
    const stubs = api();
    renderWithClient(<SupervisorSettings />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Supervisor for Wakecap' }));
    await waitFor(() =>
      expect(stubs.supervisorSetTarget).toHaveBeenCalledWith({
        targetType: 'project',
        targetId: 'wakecap',
        enabled: false,
      }),
    );
  });
});

describe('DecisionsLog', () => {
  it('lists decisions and reports a wrong answer', async () => {
    const stubs = api();
    renderWithClient(<DecisionsLog sessionPk="claude:s1" />);
    expect(await screen.findByText('Should I continue?')).toBeTruthy();
    expect(screen.getByText('answered · 93%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'That was wrong' }));
    await waitFor(() => expect(stubs.supervisorMarkWrong).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText(/added a deny rule/i)).toBeTruthy();
  });
});

describe('SupervisorToggle', () => {
  it('switches the supervisor for one session', async () => {
    const stubs = api();
    renderWithClient(
      <SupervisorToggle
        session={liveSessionFixture({ id: 's1' }, { ownership: 'owned', ptyId: 'pty-1', status: 'waiting' })}
      />,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Supervisor for this session' }));
    await waitFor(() =>
      expect(stubs.supervisorSetTarget).toHaveBeenCalledWith({
        targetType: 'session',
        targetId: 'claude:s1',
        enabled: true,
      }),
    );
  });
});
