import type { Settings } from '@orc/api-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { settingsKeys, useInstallHooks, useSettings, useUpdateSettings } from './settings.ts';

const settings = {
  recaps: {
    enabled: false,
    trigger: 'manual',
    engine: 'claude-cli',
    autoModel: 'claude-haiku-4-5',
    onDemandModel: 'claude-sonnet-5',
    monthlyBudgetUsd: 20,
    maxInputTokens: 30000,
    minPrompts: 2,
    language: 'en',
    promptTemplate: null,
    idleMinutes: 10,
    excludeProjectIds: [],
    dailyProjectIds: ['wakecap'],
  },
  limits: {
    quotaSource: 'estimate',
    officialFieldPaths: { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null },
    blockTokenLimit: null,
    weekTokenLimit: null,
    warnPct: 0.8,
    contextWindows: { 'claude-opus-5': 1000000 },
    defaultContextWindow: 200000,
    contextWarnFill: 0.85,
    pricing: {},
  },
  digest: { enabled: true, cron: '0 9 * * 1', dailyRecapCron: '0 19 * * 1-5' },
  hooks: { statusOverrideMs: 120000 },
} as unknown as Settings;

describe('settings queries', () => {
  it('caches settings and replaces them after an update', async () => {
    const settingsGet = vi.fn(async () => settings);
    const settingsUpdate = vi.fn(async () => ({
      ...settings,
      recaps: { ...settings.recaps, enabled: true },
    }));
    setApiClientForTests(fakeApi({ settingsGet, settingsUpdate }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ q: useSettings(), m: useUpdateSettings() }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.q.isSuccess).toBe(true));
    await act(async () => {
      await result.current.m.mutateAsync({ recaps: { ...settings.recaps, enabled: true } });
    });
    expect((client.getQueryData(settingsKeys.all) as Settings).recaps.enabled).toBe(true);
  });

  it('refreshes the hook status after installing', async () => {
    const hooksInstallStatus = vi.fn(async () => ({
      settingsPath: '/s.json',
      settingsExists: true,
      installed: false,
      command: 'curl …',
      snippet: '{}',
      backupDir: '/b',
    }));
    const hooksInstall = vi.fn(async () => ({
      installed: true as const,
      settingsPath: '/s.json',
      backupPath: '/b/x.json',
    }));
    setApiClientForTests(fakeApi({ hooksInstallStatus, hooksInstall }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useInstallHooks(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(hooksInstall).toHaveBeenCalledTimes(1);
  });
});
