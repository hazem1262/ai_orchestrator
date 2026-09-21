import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureToken, loadConfig, resolvePaths, saveConfig } from './config.ts';

// Every temp dir this file makes is tracked and removed when the file's tests finish. Without
// this the suite leaked ~100 directories per `pnpm test` run; 10,870 of them once filled the
// disk and produced dozens of failures that looked like flaky tests.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('uses defaults under the home directory', () => {
    const p = resolvePaths({});
    expect(p.orcHome).toBe(join(homedir(), '.orchestrator'));
    expect(p.claudeHome).toBe(join(homedir(), '.claude'));
    expect(p.codexHome).toBe(join(homedir(), '.codex'));
    expect(p.dbFile).toBe(join(homedir(), '.orchestrator', 'index.db'));
    expect(p.userHome).toBe(homedir());
  });

  it('honours env overrides and ~ expansion', () => {
    const p = resolvePaths({
      ORC_HOME: '~/x',
      CLAUDE_HOME: '/c',
      CODEX_HOME: '/d',
      ORC_USER_HOME: '/Users/test',
    });
    expect(p).toMatchObject({
      orcHome: join(homedir(), 'x'),
      claudeHome: '/c',
      codexHome: '/d',
      tokenFile: join(homedir(), 'x', 'token'),
      archiveDir: join(homedir(), 'x', 'archive'),
      logFile: join(homedir(), 'x', 'logs', 'daemon.log'),
      userHome: '/Users/test',
    });
  });
});

describe('config and token files', () => {
  const paths = () => resolvePaths({ ORC_HOME: tmpDir('orc-cfg-') });

  it('creates a default config on first load and round-trips saves', () => {
    const p = paths();
    const cfg = loadConfig(p);
    expect(cfg).toEqual(OrcConfig.parse({}));
    expect(existsSync(join(p.orcHome, 'config.json'))).toBe(true);
    saveConfig(p, { ...cfg, port: 5000 });
    expect(loadConfig(p).port).toBe(5000);
    expect(statSync(join(p.orcHome, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid config file', () => {
    const p = paths();
    saveConfig(p, OrcConfig.parse({}));
    const file = join(p.orcHome, 'config.json');
    const bad = readFileSync(file, 'utf8').replace('"port": 4317', '"port": "nope"');
    writeFileSync(file, bad);
    expect(() => loadConfig(p)).toThrow();
  });

  it('creates a 0600 token once', () => {
    const p = paths();
    const t1 = ensureToken(p);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(p.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(p)).toBe(t1);
  });
});
