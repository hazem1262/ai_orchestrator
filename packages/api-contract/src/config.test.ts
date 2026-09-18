import { describe, expect, it } from 'vitest';
import { OrcConfig, ProjectConfig } from './config.ts';

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
