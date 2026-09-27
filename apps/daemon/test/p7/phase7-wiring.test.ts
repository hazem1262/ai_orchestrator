import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhase7 } from '../../src/phase7.ts';
import {
  createFakePty,
  createMemoryScheduler,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  offlinePhase7,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup() {
  let cfg = testConfig();
  const scheduler = createMemoryScheduler();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox: fakeInbox(),
    audit: fakeAudit(),
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    recaps: fakeRecaps(),
    worktrees: fakeWorktrees(),
    pty: createFakePty(),
    launcher: fakeLauncher(),
    templates: fakeTemplates({ t: 'Tidy the README' }),
    scheduler,
  });
  const c = ctx;
  const setConfig = (patch: { enabled?: boolean; suggestions?: boolean }) => {
    cfg = OrcConfig.parse({
      ...cfg,
      automations: {
        ...cfg.automations,
        enabled: patch.enabled ?? cfg.automations.enabled,
        suggestions: { ...cfg.automations.suggestions, enabled: patch.suggestions ?? false },
      },
    });
    c.bus.emit({ type: 'config.changed' });
  };
  return { ctx: c, scheduler, setConfig };
}

const cron = {
  id: 'c1',
  name: 'Weekday digest',
  enabled: true,
  trigger: { type: 'cron' as const, cron: '0 9 * * 1-5' },
  action: {
    templateId: 't',
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 5,
    planApproval: false,
  },
  budgetUsd: 2,
};

describe('createPhase7', () => {
  it('sets the Phase 7 services on ctx and attaches cron schedules only once automations are on', async () => {
    const t = setup();
    const p7 = createPhase7(t.ctx, offlinePhase7());
    p7.start();
    expect(t.ctx.automations).toBe(p7.automations);
    expect(t.ctx.suggestions).toBe(p7.suggestions);
    expect(t.ctx.compare).toBe(p7.compare);

    p7.automations.save(cron);
    expect(t.scheduler.list('automation')).toEqual([]);

    t.setConfig({ enabled: true });
    const [job] = t.scheduler.list('automation');
    expect(job?.payload).toMatchObject({ automationId: 'c1' });

    // Master switch off again: a fired job starts nothing.
    t.setConfig({ enabled: false });
    if (!job) throw new Error('no job');
    await t.scheduler.fire('automation', job);
    expect(p7.automations.runs('c1')).toEqual([]);

    t.setConfig({ enabled: true });
    await t.scheduler.fire('automation', job);
    expect(p7.automations.runs('c1')).toHaveLength(1);
    p7.stop();
  });

  it('starts and stops suggestion collection with its switch, and stop is idempotent', () => {
    const t = setup();
    const p7 = createPhase7(t.ctx, offlinePhase7());
    const halt = vi.fn();
    const start = vi.spyOn(p7.suggestions, 'start').mockReturnValue(halt);
    p7.start();
    expect(start).not.toHaveBeenCalled();
    t.setConfig({ suggestions: true });
    expect(start).toHaveBeenCalledTimes(1);
    t.setConfig({ suggestions: false });
    expect(halt).toHaveBeenCalledTimes(1);
    t.setConfig({ suggestions: true });
    p7.stop();
    p7.stop();
    expect(halt).toHaveBeenCalledTimes(2);
    t.setConfig({ suggestions: true });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts the supervisor listener only while supervisor.enabled is on, and stops it cleanly', () => {
    const t = setup();
    const p7 = createPhase7(t.ctx, offlinePhase7());
    expect(t.ctx.supervisor).toBe(p7.supervisor);
    const halt = vi.fn();
    const start = vi.spyOn(p7.supervisor, 'start').mockReturnValue(halt);
    let cfg = t.ctx.config();
    t.ctx.config = () => cfg;
    const setSupervisor = (enabled: boolean) => {
      cfg = OrcConfig.parse({ ...cfg, supervisor: { ...cfg.supervisor, enabled } });
      t.ctx.bus.emit({ type: 'config.changed' });
    };
    p7.start();
    expect(start).not.toHaveBeenCalled();
    setSupervisor(true);
    expect(start).toHaveBeenCalledTimes(1);
    setSupervisor(true);
    expect(start).toHaveBeenCalledTimes(1);
    setSupervisor(false);
    expect(halt).toHaveBeenCalledTimes(1);
    setSupervisor(true);
    p7.stop();
    expect(halt).toHaveBeenCalledTimes(2);
    setSupervisor(false);
    setSupervisor(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('polls AGNC (fake server, memory secrets) only while agnc.enabled is on', async () => {
    const t = setup();
    const p7 = createPhase7(t.ctx, offlinePhase7());
    expect(t.ctx.agnc).toBe(p7.agnc);
    const seen: string[] = [];
    t.ctx.bus.on('session.updated', (e) => {
      if (e.session.source === 'agnc') seen.push(e.session.id);
    });
    let cfg = t.ctx.config();
    t.ctx.config = () => cfg;
    const setAgnc = (enabled: boolean) => {
      cfg = OrcConfig.parse({ ...cfg, agnc: { ...cfg.agnc, enabled } });
      t.ctx.bus.emit({ type: 'config.changed' });
    };
    p7.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
    setAgnc(true);
    await vi.waitFor(() => expect(seen).toEqual(['ag-1', 'ag-2']));
    setAgnc(false);
    p7.stop();
  });
});
