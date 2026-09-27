import { describe, expect, it } from 'vitest';
import { OrcConfig } from './config.ts';

describe('OrcConfig phase 7 blocks', () => {
  it('defaults every phase 7 feature to off', () => {
    const c = OrcConfig.parse({});
    expect(c.automations).toEqual({
      enabled: false,
      maxConcurrent: 2,
      suggestions: { enabled: false, intervalMin: 60 },
    });
    expect(c.supervisor.enabled).toBe(false);
    expect(c.supervisor.model).toBe('claude-haiku-4-5');
    expect(c.supervisor.confidenceThreshold).toBe(0.85);
    expect(c.supervisor.maxPerSessionPerHour).toBe(3);
    expect(c.supervisor.maxPerHour).toBe(10);
    expect(c.supervisor.monthlyBudgetUsd).toBe(5);
    expect(c.supervisor.quietHours).toBeNull();
    expect(c.compare.maxVariants).toBe(4);
    expect(c.agnc).toEqual({ enabled: false, url: 'https://agnc.wakecap.ai/mcp', pollSeconds: 30 });
  });

  it('rejects malformed quiet hours', () => {
    expect(() => OrcConfig.parse({ supervisor: { quietHours: { start: '10pm', end: '08:00' } } })).toThrow();
  });
});
