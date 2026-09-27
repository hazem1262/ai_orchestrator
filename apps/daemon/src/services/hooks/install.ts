import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInstallStatus } from '@orc/api-contract';
import { BRIDGE_HOOK_EVENTS } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../errors.ts';

export const HOOK_MARKER = '# orc-hook-bridge';
export const INSTALL_EVENTS: readonly string[] = BRIDGE_HOOK_EVENTS;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const HOOK_TIMEOUT_S = 5;

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function buildHookCommand(o: { tokenFile: string; port: number }): string {
  return [
    'curl -s -m 2 -X POST',
    "-H 'content-type: application/json'",
    `-H "x-orc-token: $(cat ${shellQuote(o.tokenFile)})"`,
    '--data-binary @-',
    `http://127.0.0.1:${o.port}/api/hooks >/dev/null 2>&1 || true ${HOOK_MARKER}`,
  ].join(' ');
}

type HookEntry = { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> };

export function hookSettingsFragment(command: string): { hooks: Record<string, HookEntry[]> } {
  const hooks: Record<string, HookEntry[]> = {};
  for (const ev of INSTALL_EVENTS) {
    const entry: HookEntry = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] };
    hooks[ev] = [TOOL_EVENTS.has(ev) ? { matcher: '*', ...entry } : entry];
  }
  return { hooks };
}

export function isOrcHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes(HOOK_MARKER) || (command.includes('/api/hooks') && command.includes('x-orc-token'));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function entryIsOurs(entry: unknown): boolean {
  if (!isObj(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => isObj(h) && isOrcHookCommand(h.command));
}

export function isHookInstalled(settings: unknown): boolean {
  if (!isObj(settings) || !isObj(settings.hooks)) return false;
  const hooks = settings.hooks;
  return INSTALL_EVENTS.every((ev) => {
    const list = hooks[ev];
    return (
      Array.isArray(list) &&
      list.some(
        (e) =>
          isObj(e) &&
          Array.isArray(e.hooks) &&
          e.hooks.some((h) => isObj(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARKER)),
      )
    );
  });
}

export function mergeHookSettings(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  const current = isObj(settings.hooks) ? settings.hooks : {};
  const next: Record<string, unknown> = {};
  for (const [ev, list] of Object.entries(current)) {
    const kept = Array.isArray(list) ? list.filter((e) => !entryIsOurs(e)) : list;
    if (!Array.isArray(kept) || kept.length > 0) next[ev] = kept;
  }
  for (const [ev, entries] of Object.entries(hookSettingsFragment(command).hooks)) {
    const existing = Array.isArray(next[ev]) ? (next[ev] as unknown[]) : [];
    next[ev] = [...existing, ...entries];
  }
  return { ...settings, hooks: next };
}

const settingsPathOf = (ctx: DaemonContext) => join(ctx.paths.claudeHome, 'settings.json');
const backupDirOf = (ctx: DaemonContext) => join(ctx.paths.orcHome, 'backups');
const commandFor = (ctx: DaemonContext) =>
  buildHookCommand({ tokenFile: ctx.paths.tokenFile, port: ctx.config().port });

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ServiceError('settings_unreadable', 422, `${path} is not valid JSON; fix it by hand first`);
  }
  if (!isObj(v)) throw new ServiceError('settings_unreadable', 422, `${path} is not a JSON object`);
  return v;
}

export function hookInstallStatus(ctx: DaemonContext): HookInstallStatus {
  const settingsPath = settingsPathOf(ctx);
  const command = commandFor(ctx);
  let installed = false;
  try {
    installed = isHookInstalled(readSettings(settingsPath));
  } catch {
    installed = false;
  }
  return {
    settingsPath,
    settingsExists: existsSync(settingsPath),
    installed,
    command,
    snippet: JSON.stringify(hookSettingsFragment(command), null, 2),
    backupDir: backupDirOf(ctx),
  };
}

/** The only Phase 5 write to ~/.claude. Callers must have confirmation; the route is audited as hook.install. */
export function installHooks(
  ctx: DaemonContext,
  now: () => Date = () => new Date(),
): { settingsPath: string; backupPath: string | null } {
  const settingsPath = settingsPathOf(ctx);
  const settings = readSettings(settingsPath);
  let backupPath: string | null = null;
  let mode = 0o644;
  if (existsSync(settingsPath)) {
    mode = statSync(settingsPath).mode & 0o777;
    mkdirSync(backupDirOf(ctx), { recursive: true, mode: 0o700 });
    backupPath = join(backupDirOf(ctx), `claude-settings-${now().toISOString().replace(/[:.]/g, '-')}.json`);
    copyFileSync(settingsPath, backupPath);
    chmodSync(backupPath, 0o600);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const tmp = `${settingsPath}.orc-tmp`;
  writeFileSync(tmp, `${JSON.stringify(mergeHookSettings(settings, commandFor(ctx)), null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, settingsPath);
  return { settingsPath, backupPath };
}

function findDaemonRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (
      existsSync(pkg) &&
      (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@orc/daemon'
    )
      return dir;
    dir = dirname(dir);
  }
  return start;
}

export function statuslineCommand(): string {
  const root = findDaemonRoot(dirname(fileURLToPath(import.meta.url)));
  return `node ${shellQuote(join(root, 'dist', 'orc-statusline.js'))}`;
}

export function statuslineSnippet(): string {
  return JSON.stringify(
    { statusLine: { type: 'command', command: statuslineCommand(), padding: 0 } },
    null,
    2,
  );
}
