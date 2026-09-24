import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSessionExport, useSessionSafety } from '@/api/queries/session-detail';
import { renderP3 } from '@/test/p3-render';
import { ExportButton } from './ExportButton.tsx';
import { SafetyBadges } from './SafetyBadges.tsx';

vi.mock('@/api/queries/session-detail', () => ({
  useSessionSafety: vi.fn(),
  downloadSessionExport: vi.fn(async () => undefined),
}));

beforeEach(() => vi.clearAllMocks());

describe('SafetyBadges', () => {
  it('shows the permission badge and prod touches', () => {
    vi.mocked(useSessionSafety).mockReturnValue({
      data: {
        permissionMode: 'bypassPermissions',
        permissionBadge: 'bypass',
        touchedProd: true,
        prodTouches: [
          {
            seq: 2,
            ts: '',
            agentId: null,
            kind: 'command',
            tool: 'Bash',
            detail: 'PGPASSWORD=«redacted:secret» psql -h prod-db',
          },
          { seq: 3, ts: '', agentId: null, kind: 'skill', tool: 'Skill', detail: 'production_server_db' },
        ],
      },
    } as never);
    renderP3(<SafetyBadges source="claude" id="s-drift" />);
    expect(screen.getByText('bypass').getAttribute('title')).toBe('permission mode: bypassPermissions');
    const prod = screen.getByText('PROD ×2');
    expect(prod.getAttribute('title')).toContain('production_server_db');
  });

  it('labels unusual modes as custom', () => {
    vi.mocked(useSessionSafety).mockReturnValue({
      data: { permissionMode: 'weird', permissionBadge: 'custom', touchedProd: false, prodTouches: [] },
    } as never);
    renderP3(<SafetyBadges source="claude" id="s-x" />);
    expect(screen.getByText('custom')).toBeDefined();
    expect(screen.queryByText(/PROD/)).toBeNull();
  });
});

describe('ExportButton', () => {
  it('exports redacted by default and asks before an unredacted export', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderP3(<ExportButton source="claude" id="s-drift" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's-drift', { redact: true });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include secrets (unredacted)' }));
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's-drift', { redact: false });
  });
});
