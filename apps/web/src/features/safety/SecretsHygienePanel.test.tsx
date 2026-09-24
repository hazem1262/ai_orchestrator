import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useSecretsReport } from '@/api/queries/safety';
import { renderP3 } from '@/test/p3-render';
import { SecretsHygienePanel } from './SecretsHygienePanel.tsx';

vi.mock('@/api/queries/safety', () => ({ useSecretsReport: vi.fn() }));

describe('SecretsHygienePanel', () => {
  it('lists findings by file, kind and line, and can rescan', async () => {
    const refetch = vi.fn();
    vi.mocked(useSecretsReport).mockReturnValue({
      data: {
        scannedAt: '2026-09-17T10:00:00.000Z',
        totalFindings: 3,
        files: [
          {
            path: '/h/Wakecap/.mcp.json',
            displayPath: '~/Wakecap/.mcp.json',
            exists: true,
            findings: [
              { line: 3, kind: 'github' },
              { line: 3, kind: 'json-secret-field' },
            ],
            error: null,
          },
          {
            path: '/h/Wakecap/.claude/commands/db.md',
            displayPath: '~/Wakecap/.claude/commands/db.md',
            exists: true,
            findings: [{ line: 2, kind: 'secret' }],
            error: null,
          },
          {
            path: '/h/Wakecap/.claude/commands/clean.md',
            displayPath: '~/Wakecap/.claude/commands/clean.md',
            exists: true,
            findings: [],
            error: null,
          },
          {
            path: '/h/missing.json',
            displayPath: '~/missing.json',
            exists: false,
            findings: [],
            error: null,
          },
        ],
      },
      isError: false,
      isFetching: false,
      refetch,
    } as never);
    renderP3(<SecretsHygienePanel />);
    expect(screen.getByTestId('secrets-summary').textContent).toContain('3 findings in 2 files');
    expect(
      screen.getByRole('row', {
        name: /~\/Wakecap\/\.mcp\.json.*line 3 · github.*line 3 · json-secret-field/,
      }),
    ).toBeDefined();
    expect(screen.getByRole('row', { name: /clean\.md.*clean/ })).toBeDefined();
    expect(screen.getByRole('row', { name: /missing\.json.*not found/ })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(refetch).toHaveBeenCalled();
  });
});
