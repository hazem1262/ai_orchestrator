import type { ArchiveStatus, NotificationPrefs } from '@orc/api-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ArchiveSettings } from './ArchiveSettings.tsx';
import { daysAgo, formatBytes, retentionWarning } from './format.ts';
import { HookSetup } from './HookSetup.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';

const status: ArchiveStatus = {
  enabled: true,
  files: 812,
  bytes: 73_400_000,
  oldestTranscript: '2026-08-16T00:00:00.000Z',
  cleanupPeriodDays: null,
  codec: 'zstd',
  recommendedSnippet: '{\n  "cleanupPeriodDays": 3650\n}',
};
const prefs: NotificationPrefs = {
  waiting: { enabled: true, channels: ['macos'] },
  review: { enabled: true, channels: ['macos'] },
  error: { enabled: true, channels: ['macos'] },
  tests_red: { enabled: true, channels: ['macos'] },
};
const archiveStatus = vi.fn(async () => status);
const archiveSync = vi.fn(async () => ({ copied: 3 }));
const notificationsGet = vi.fn(async () => prefs);
const notificationsPut = vi.fn(async (p: NotificationPrefs) => p);
const writeText = vi.fn(async () => {});

function api() {
  return createFakeApi({ archiveStatus, archiveSync, notificationsGet, notificationsPut });
}

beforeEach(() => {
  for (const f of [archiveStatus, archiveSync, notificationsGet, notificationsPut, writeText]) {
    f.mockClear();
  }
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

describe('format helpers', () => {
  it('formats sizes, ages and warnings', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(73_400_000)).toBe('70.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(daysAgo('2026-08-16T00:00:00.000Z', Date.parse('2026-09-17T12:00:00.000Z'))).toBe(32);
    expect(retentionWarning({ enabled: false, cleanupPeriodDays: 3650 })).toMatch(/Archive is off/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: null })).toMatch(/after 30 days \(default\)/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: 45 })).toMatch(/after 45 days/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: 365 })).toBeNull();
  });
});

describe('ArchiveSettings', () => {
  it('shows status, warning and snippet, and syncs on demand', async () => {
    renderWithProviders(<ArchiveSettings now={() => Date.parse('2026-09-17T12:00:00.000Z')} />, {
      api: api(),
    });
    expect(await screen.findByText('812 files · 70.0 MB · zstd')).toBeTruthy();
    expect(screen.getByText('Oldest transcript on disk: 2026-08-16 (32 days ago)')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/30 days \(default\)/);
    expect(screen.getByText(/"cleanupPeriodDays": 3650/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy snippet' }));
    expect(writeText).toHaveBeenCalledWith(status.recommendedSnippet);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await vi.waitFor(() => expect(archiveSync).toHaveBeenCalled());
    expect(await screen.findByText('Copied 3 new or grown transcripts.')).toBeTruthy();
  });
});

describe('NotificationSettings', () => {
  it('toggles kinds and channels and saves', async () => {
    renderWithProviders(<NotificationSettings />, { api: api() });
    const waiting = await screen.findByRole('checkbox', { name: 'Waiting for input: enabled' });
    fireEvent.click(waiting);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ready for review: macOS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan awaiting approval: enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save notifications' }));
    await vi.waitFor(() => expect(notificationsPut).toHaveBeenCalled());
    const saved = notificationsPut.mock.calls[0]?.[0];
    expect(saved?.waiting).toEqual({ enabled: false, channels: ['macos'] });
    expect(saved?.review).toEqual({ enabled: true, channels: [] });
    expect(saved?.plan_approval).toEqual({ enabled: true, channels: ['macos'] });
  });
});

describe('HookSetup', () => {
  it('shows the optional hook snippet with a copy button', () => {
    renderWithProviders(<HookSetup />, { api: api() });
    expect(screen.getByText(/api\/hooks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy hook snippet' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"Notification"'));
  });
});
