import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeP5Context } from '../../../test/p5-helpers.ts';
import type { DaemonContext } from '../../context.ts';
import {
  buildHookCommand,
  HOOK_MARKER,
  hookInstallStatus,
  installHooks,
  isHookInstalled,
  mergeHookSettings,
  shellQuote,
} from './install.ts';

const P2_SNIPPET_CMD =
  'curl -s -m 2 -X POST -H "x-orc-token: $(cat ~/.orchestrator/token)" -H \'content-type: application/json\' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true';

/** The installer writes Claude's settings.json: every path it can touch must be a mkdtemp home. */
function assertTempHomes(ctx: DaemonContext): void {
  for (const p of [ctx.paths.claudeHome, ctx.paths.orcHome, ctx.paths.tokenFile]) {
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p.startsWith(join(homedir(), '.claude'))).toBe(false);
    expect(p.startsWith(join(homedir(), '.orchestrator'))).toBe(false);
  }
}

describe('hook settings helpers', () => {
  it('builds a safe, non-blocking command', () => {
    expect(shellQuote("/Users/o'neil/.orc/token")).toBe("'/Users/o'\\''neil/.orc/token'");
    const cmd = buildHookCommand({ tokenFile: '/Users/test/.orchestrator/token', port: 4317 });
    expect(cmd).toBe(
      `curl -s -m 2 -X POST -H 'content-type: application/json' -H "x-orc-token: $(cat '/Users/test/.orchestrator/token')" --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null 2>&1 || true ${HOOK_MARKER}`,
    );
  });

  it('merges idempotently, keeps foreign hooks and replaces the P2 snippet', () => {
    const cmd = buildHookCommand({ tokenFile: '/t', port: 4317 });
    const existing = {
      model: 'opus',
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: '~/.claude/hooks/post-edit-check.sh' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: P2_SNIPPET_CMD }] }],
      },
    };
    expect(isHookInstalled(existing)).toBe(false);
    const once = mergeHookSettings(existing, cmd);
    const twice = mergeHookSettings(once, cmd);
    expect(twice).toEqual(once);
    expect(isHookInstalled(once)).toBe(true);
    expect(once.model).toBe('opus');
    const hooks = once.hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('~/.claude/hooks/post-edit-check.sh');
    expect(hooks.PostToolUse?.[1]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: cmd, timeout: 5 }],
    });
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  });
});

describe('installHooks', () => {
  it('reports status without writing, then installs with a backup', () => {
    const { ctx } = makeP5Context();
    assertTempHomes(ctx);
    const settings = join(ctx.paths.claudeHome, 'settings.json');
    mkdirSync(ctx.paths.claudeHome, { recursive: true });
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30 }));
    chmodSync(settings, 0o640);
    const before = readFileSync(settings, 'utf8');
    const st = hookInstallStatus(ctx);
    expect(st).toMatchObject({
      settingsPath: settings,
      settingsExists: true,
      installed: false,
      backupDir: join(ctx.paths.orcHome, 'backups'),
    });
    expect(JSON.parse(st.snippet).hooks.Stop).toHaveLength(1);
    expect(readFileSync(settings, 'utf8')).toBe(before);

    const res = installHooks(ctx, () => new Date('2026-09-17T10:00:00.000Z'));
    expect(res).toEqual({
      settingsPath: settings,
      backupPath: join(ctx.paths.orcHome, 'backups', 'claude-settings-2026-09-17T10-00-00-000Z.json'),
    });
    expect(readFileSync(res.backupPath as string, 'utf8')).toBe(before);
    expect((statSync(res.backupPath as string).mode & 0o777).toString(8)).toBe('600');
    const after = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(after.cleanupPeriodDays).toBe(30);
    expect(isHookInstalled(after)).toBe(true);
    expect((statSync(settings).mode & 0o777).toString(8)).toBe('640');
    expect(existsSync(`${settings}.orc-tmp`)).toBe(false);
    expect(hookInstallStatus(ctx).installed).toBe(true);
    expect(readdirSync(ctx.paths.claudeHome).filter((f) => f.startsWith('settings'))).toEqual([
      'settings.json',
    ]);
  });

  it('creates settings when missing and refuses invalid JSON', () => {
    const { ctx } = makeP5Context();
    assertTempHomes(ctx);
    const settings = join(ctx.paths.claudeHome, 'settings.json');
    expect(installHooks(ctx).backupPath).toBeNull();
    expect(isHookInstalled(JSON.parse(readFileSync(settings, 'utf8')))).toBe(true);
    writeFileSync(settings, '{ nope');
    expect(() => installHooks(ctx)).toThrow(/settings_unreadable|not valid JSON/);
    expect(readFileSync(settings, 'utf8')).toBe('{ nope');
  });
});
