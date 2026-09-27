import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { BridgeSettings } from './BridgeSettings.tsx';

const status = {
  settingsPath: '/Users/test/.claude/settings.json',
  settingsExists: true,
  installed: false,
  command: 'curl -s … # orc-hook-bridge',
  snippet: '{\n  "hooks": {}\n}',
  backupDir: '/Users/test/.orchestrator/backups',
};

describe('BridgeSettings', () => {
  it('shows the snippet and only installs after a confirmation', async () => {
    const hooksInstall = vi.fn(async () => ({
      installed: true as const,
      settingsPath: status.settingsPath,
      backupPath: '/Users/test/.orchestrator/backups/claude-settings-x.json',
    }));
    setApiClientForTests(
      fakeApi({
        hooksInstallStatus: vi.fn(async () => status),
        hooksInstall,
        hooksStatusline: vi.fn(async () => ({
          command: 'node /x/dist/orc-statusline.js',
          snippet: '{"statusLine":{}}',
        })),
      }),
    );
    const user = userEvent.setup();
    renderP3(<BridgeSettings />);
    expect(await screen.findByText(/"hooks"/)).toBeTruthy();
    expect(screen.getByText(status.settingsPath)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Install hooks…' }));
    expect(hooksInstall).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(status.backupDir))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm — write settings.json' }));
    await waitFor(() => expect(hooksInstall).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Backup written to/)).toBeTruthy();
  });

  it('shows the statusline snippet as copy-only', async () => {
    setApiClientForTests(
      fakeApi({
        hooksInstallStatus: vi.fn(async () => ({ ...status, installed: true })),
        hooksInstall: vi.fn(async () => ({ installed: true as const, settingsPath: '/x', backupPath: null })),
        hooksStatusline: vi.fn(async () => ({
          command: 'node /x/dist/orc-statusline.js',
          snippet: '{"statusLine":{"type":"command"}}',
        })),
      }),
    );
    renderP3(<BridgeSettings />);
    expect(await screen.findByText('Hooks are installed.')).toBeTruthy();
    expect(screen.getByText(/"statusLine"/)).toBeTruthy();
    expect(screen.getByText(/add it to .* yourself/i)).toBeTruthy();
  });
});
