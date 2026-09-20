import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { eventFixture as ev, sessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionDetailPage } from './SessionDetailPage.tsx';

const session = sessionFixture({
  cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/svc'],
  tickets: ['SAF-1787'],
  prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
  lastTest: { ts: 't', command: 'pnpm vitest run', passed: 18, failed: 0, skipped: 0, durationMs: 1400 },
  flags: { touchedProd: true, hasSubagents: false, automated: false },
});

describe('SessionDetailPage', () => {
  it('renders the header and a grouped, paged timeline', async () => {
    const sessionsEvents = vi.fn(async (_s: string, _i: string, opts?: { afterSeq?: number }) =>
      (opts?.afterSeq ?? 0) === 0
        ? {
            items: [
              ev({ seq: 1, kind: 'prompt', text: 'check the notification service tests' }),
              ev({
                seq: 2,
                kind: 'tool_call',
                tool: 'Bash',
                toolUseId: 't1',
                input: { command: 'pnpm vitest run' },
              }),
              ev({ seq: 3, kind: 'tool_result', toolUseId: 't1', text: 'Tests 18 passed' }),
              ev({
                seq: 4,
                kind: 'tool_call',
                tool: 'Bash',
                toolUseId: 't2',
                input: { command: 'git status' },
              }),
            ],
            nextSeq: 4,
          }
        : {
            items: [
              ev({ seq: 5, kind: 'system', tool: 'turn_duration', durationMs: 36000 }),
              ev({ seq: 6, kind: 'error', text: 'API Error: 529 overloaded' }),
              ev({ seq: 7, kind: 'prompt', turn: 2, text: 'continue' }),
              ev({ seq: 8, kind: 'system', turn: 2, tool: 'away_summary', text: 'Ran tests.' }),
            ],
            nextSeq: null,
          },
    );
    const api = createFakeApi({ sessionsGet: vi.fn(async () => session), sessionsEvents });
    renderWithProviders(<SessionDetailPage source="claude" id="s1" />, { api });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Notification service test check' }),
    ).toBeTruthy();
    expect(screen.getByText('(+1 drift)')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#231' }).getAttribute('href')).toBe(
      'https://github.com/example-org/svc/pull/231',
    );
    expect(screen.getByText('SAF-1787')).toBeTruthy();
    expect(screen.getByText('✓ 18 · ✗ 0')).toBeTruthy();
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('$0.42 · 2.2k tokens')).toBeTruthy();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('check the notification service tests')).toBeTruthy();
    expect(within(timeline).getByText('Bash ×2')).toBeTruthy();
    expect(within(timeline).getByText('pnpm vitest run')).toBeTruthy();
    expect(within(timeline).getByText('Tests 18 passed')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(timeline).findByText('Turn took 36s')).toBeTruthy();
    expect(within(timeline).getByText('API error: API Error: 529 overloaded')).toBeTruthy();
    expect(within(timeline).getByText('Recap: Ran tests.')).toBeTruthy();
    expect(sessionsEvents).toHaveBeenLastCalledWith('claude', 's1', {
      agentId: undefined,
      afterSeq: 4,
      limit: 200,
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('explains prompts-only sessions and missing sessions', async () => {
    const api = createFakeApi({
      sessionsGet: vi.fn(async () => sessionFixture({ availability: 'prompts-only', transcriptPath: null })),
    });
    renderWithProviders(<SessionDetailPage source="claude" id="s1" />, { api });
    expect(await screen.findByText(/only exists in prompt history/)).toBeTruthy();
    expect(screen.getByText('prompts-only')).toBeTruthy();
  });

  it('shows an error when the session cannot be loaded', async () => {
    const api = createFakeApi({
      sessionsGet: vi.fn(async () => {
        throw new Error('session claude:nope not found');
      }),
    });
    renderWithProviders(<SessionDetailPage source="claude" id="nope" />, { api });
    expect((await screen.findByRole('alert')).textContent).toBe('session claude:nope not found');
  });
});
