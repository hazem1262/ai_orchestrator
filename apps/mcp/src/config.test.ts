import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDaemonConfig } from './daemon-client.ts';
import { installSnippet } from './main.ts';

const dirs: string[] = [];
const tempHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'orc-mcp-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveDaemonConfig', () => {
  it('reads the token from $ORC_HOME/token and defaults to 127.0.0.1:4317', () => {
    const home = tempHome();
    writeFileSync(join(home, 'token'), 'abc123\n');
    expect(resolveDaemonConfig({ ORC_HOME: home })).toEqual({
      baseUrl: 'http://127.0.0.1:4317',
      token: 'abc123',
    });
  });

  it('follows the daemon config.json port, then ORC_PORT, then ORC_URL', () => {
    const home = tempHome();
    writeFileSync(join(home, 'token'), 'tok');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 5123 }));
    expect(resolveDaemonConfig({ ORC_HOME: home }).baseUrl).toBe('http://127.0.0.1:5123');
    expect(resolveDaemonConfig({ ORC_HOME: home, ORC_PORT: '6000' }).baseUrl).toBe('http://127.0.0.1:6000');
    expect(resolveDaemonConfig({ ORC_HOME: home, ORC_URL: 'http://127.0.0.1:7000/' }).baseUrl).toBe(
      'http://127.0.0.1:7000',
    );
  });

  it('prefers ORC_TOKEN and explains a missing token file', () => {
    const home = tempHome();
    expect(resolveDaemonConfig({ ORC_HOME: home, ORC_TOKEN: 'env-tok' }).token).toBe('env-tok');
    expect(() => resolveDaemonConfig({ ORC_HOME: home })).toThrow(/cannot read the orchestrator token/);
  });
});

describe('installSnippet', () => {
  it('prints the claude and codex registration commands', () => {
    expect(installSnippet('/opt/orc/apps/mcp/dist/main.js').split('\n')).toEqual([
      'claude mcp add --scope user orchestrator -- node /opt/orc/apps/mcp/dist/main.js',
      'codex mcp add orchestrator -- node /opt/orc/apps/mcp/dist/main.js',
    ]);
    expect(installSnippet('/Users/me/My Code/main.js')).toContain("node '/Users/me/My Code/main.js'");
  });
});
