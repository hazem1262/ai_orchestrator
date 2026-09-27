import { describe, expect, it } from 'vitest';
import { DigestConfig, HooksConfig, LimitsConfig, OrcConfig, ProjectConfig, RecapsConfig } from './config.ts';

describe('OrcConfig', () => {
  it('fills defaults from an empty object', () => {
    const c = OrcConfig.parse({});
    expect(c.port).toBe(4317);
    expect(c.defaultProjectId).toBe('wakecap');
    expect(c.resumeProfile.claudeArgs).toEqual(['--dangerously-skip-permissions']);
    expect(c.recaps.autoModel).toBe('claude-haiku-4-5');
    expect(c.recaps.onDemandModel).toBe('claude-sonnet-5');
    expect(c.codex.showAutomated).toBe(false);
  });

  it('fills project defaults', () => {
    const c = OrcConfig.parse({
      projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/Users/test/Wakecap'] }],
    });
    expect(c.projects[0]?.maxConcurrentOwned).toBe(6);
    expect(c.projects[0]?.features.workStreams).toBe(false);
  });

  it('rejects an unknown top-level key instead of silently discarding it', () => {
    expect(() => OrcConfig.parse({ typoedKeyThatDoesNotExist: true })).toThrow();
  });

  it('fills phase 3 safety and links defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.safety.extraDenyPatterns).toEqual([]);
    expect(c.safety.prodSkills).toEqual([
      'production_server_db',
      'production_server_logs',
      'wecare_production_db',
    ]);
    expect(c.safety.secretScanPaths).toEqual(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']);
    expect(c.links).toEqual({ linearWorkspace: null, planRoots: ['~/Wakecap/plans'] });
  });
});

describe('ProjectConfig', () => {
  it('rejects an unknown key instead of silently discarding it', () => {
    expect(() =>
      ProjectConfig.parse({
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: ['/Users/test/Wakecap'],
        typoedKeyThatDoesNotExist: true,
      }),
    ).toThrow();
  });
});

describe('OrcConfig phase 5 sections', () => {
  it('fills recaps, limits, digest and hooks defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.recaps.idleMinutes).toBe(10);
    expect(c.recaps.excludeProjectIds).toEqual([]);
    expect(c.recaps.dailyProjectIds).toEqual(['wakecap']);
    expect(c.recaps.monthlyBudgetUsd).toBe(20);
    // S7 decided `official` (plan/spikes/S7.md): the default source and field paths follow it.
    expect(c.limits.quotaSource).toBe('official');
    expect(c.limits.officialFieldPaths.blockPct).toBe('rate_limits.five_hour.used_percentage');
    expect(c.limits.officialFieldPaths.blockResetsAt).toBe('rate_limits.five_hour.resets_at');
    expect(c.limits.officialFieldPaths.weekPct).toBe('rate_limits.seven_day.used_percentage');
    expect(c.limits.officialFieldPaths.weekResetsAt).toBe('rate_limits.seven_day.resets_at');
    expect(c.limits.blockTokenLimit).toBeNull();
    expect(c.limits.warnPct).toBe(0.8);
    expect(c.limits.contextWindows['claude-opus-5']).toBe(1000000);
    expect(c.limits.contextWindows['claude-haiku-4-5']).toBe(200000);
    expect(c.limits.pricing['claude-sonnet-5']).toEqual({
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2,
    });
    expect(c.limits.contextWarnFill).toBe(0.85);
    expect(c.digest.cron).toBe('0 9 * * 1');
    expect(c.digest.dailyRecapCron).toBe('0 19 * * 1-5');
    expect(c.hooks.statusOverrideMs).toBe(120000);
  });

  it('exposes each section as its own schema', () => {
    expect(RecapsConfig.parse({}).engine).toBe('claude-cli');
    expect(LimitsConfig.parse({ blockTokenLimit: 5000 }).blockTokenLimit).toBe(5000);
    expect(DigestConfig.parse({}).enabled).toBe(true);
    expect(HooksConfig.parse({}).statusOverrideMs).toBe(120000);
  });

  it('rejects an out-of-range warnPct', () => {
    expect(() => LimitsConfig.parse({ warnPct: 1.5 })).toThrow();
  });
});
