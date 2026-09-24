import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSafetyRoutes } from '../src/http/routes/safety.ts';
import { createDenyList } from '../src/services/safety/deny-list.ts';
import {
  createSecretsScanner,
  expandScanPaths,
  isForbiddenPath,
} from '../src/services/safety/secrets-scan.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';

const pat = `gh${'p_'}${'c'.repeat(36)}`;
const pw = `hunt${'er2'}`;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orc-home-'));
  mkdirSync(join(home, 'Wakecap/.claude/commands'), { recursive: true });
  writeFileSync(
    join(home, 'Wakecap/.mcp.json'),
    `{\n  "mcpServers": {\n    "github": { "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${pat}" } }\n  }\n}\n`,
  );
  writeFileSync(join(home, 'Wakecap/.claude/commands/db.md'), `Connect with\nPGPASSWORD=${pw} psql\n`);
  writeFileSync(join(home, 'Wakecap/.claude/commands/clean.md'), '# clean\nnothing here\n');
  writeFileSync(join(home, 'Wakecap/.claude/commands/notes.txt'), `PGPASSWORD=${pw}\n`);
  return home;
}

const scanPaths = [
  '~/Wakecap/.mcp.json',
  '~/Wakecap/.claude/commands/*.md',
  '~/missing.json',
  '~/.codex/auth.json',
];

describe('createDenyList', () => {
  it('merges defaults, config extras and project prodPatterns', () => {
    const cfg = OrcConfig.parse({
      safety: { extraDenyPatterns: ['make\\s+release'] },
      projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/x'], prodPatterns: ['wecare-prod'] }],
    });
    const dl = createDenyList({
      config: () => cfg,
      projects: { get: (id) => cfg.projects.find((p) => p.id === id) ?? null },
    });
    expect(dl.check('rm -rf /', null).denied).toBe(true);
    expect(dl.check('make release', null).denied).toBe(true);
    expect(dl.check('ssh wecare-prod', 'wakecap').denied).toBe(true);
    expect(dl.check('ssh wecare-prod', null).denied).toBe(false);
    expect(dl.check('ssh wecare-prod', 'other').denied).toBe(false);
  });
});

describe('secrets scanner', () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });

  it('expands ~ and *.md globs in pattern order', async () => {
    const paths = await expandScanPaths(scanPaths, home);
    expect(paths).toEqual([
      join(home, 'Wakecap/.mcp.json'),
      join(home, 'Wakecap/.claude/commands/clean.md'),
      join(home, 'Wakecap/.claude/commands/db.md'),
      join(home, 'missing.json'),
      join(home, '.codex/auth.json'),
    ]);
  });

  it('reports file, kind and line only, never values, and never writes', async () => {
    const mcp = join(home, 'Wakecap/.mcp.json');
    const before = statSync(mcp).mtimeMs;
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: scanPaths } });
    const report = await createSecretsScanner({
      config: () => cfg,
      home,
      now: () => new Date('2026-09-17T00:00:00Z'),
    }).scan();
    expect(report.scannedAt).toBe('2026-09-17T00:00:00.000Z');
    expect(report.files.map((f) => [f.displayPath, f.exists, f.findings, f.error])).toEqual([
      [
        '~/Wakecap/.mcp.json',
        true,
        [
          { line: 3, kind: 'github' },
          { line: 3, kind: 'json-secret-field' },
        ],
        null,
      ],
      ['~/Wakecap/.claude/commands/clean.md', true, [], null],
      ['~/Wakecap/.claude/commands/db.md', true, [{ line: 2, kind: 'secret' }], null],
      ['~/missing.json', false, [], null],
      ['~/.codex/auth.json', false, [], 'forbidden'],
    ]);
    expect(report.totalFindings).toBe(3);
    const json = JSON.stringify(report);
    expect(json).not.toContain(pat);
    expect(json).not.toContain(pw);
    expect(statSync(mcp).mtimeMs).toBe(before);
  });

  it('skips files that are too large', async () => {
    writeFileSync(join(home, 'big.json'), 'x'.repeat(2048));
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: ['~/big.json'] } });
    const report = await createSecretsScanner({ config: () => cfg, home, maxBytes: 1024 }).scan();
    expect(report.files[0]?.error).toBe('too_large');
  });

  it.each([
    ['/Users/x/.claude/sessions/1.abc.key', true],
    ['/Users/x/.codex/auth.json', true],
    ['/Users/x/.claude.json', true],
    ['/Users/x/Wakecap/.mcp.json', false],
  ])('isForbiddenPath(%s) = %s', (p, expected) => {
    expect(isForbiddenPath(p)).toBe(expected);
  });
});

describe('safety routes', () => {
  let t: P3Harness;
  beforeEach(async () => {
    t = await createP3Harness();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('GET /api/safety/secrets returns the report', async () => {
    const home = makeHome();
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: ['~/Wakecap/.mcp.json'] } });
    const app = new Hono<{ Bindings: HttpBindings }>();
    registerSafetyRoutes(app, { ...t.ctx, config: () => cfg }, { home });
    const res = await app.request('/api/safety/secrets');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"kind":"github"');
    expect(text).not.toContain(pat);
  });

  it('POST /api/safety/deny-check evaluates through the context deny-list', async () => {
    const post = (body: unknown) => t.request('/api/safety/deny-check', { method: 'POST', body });
    const denied = await post({ text: 'git push --force', projectId: null });
    expect(await denied.json()).toMatchObject({ denied: true });
    const allowed = await post({ text: 'git status' });
    expect(await allowed.json()).toEqual({ denied: false, reason: null });
    expect((await post({ nope: 1 })).status).toBe(400);
  });
});
