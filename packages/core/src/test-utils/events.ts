import type { TimelineEvent, Usage } from '../types/index.ts';

export function ev(p: Partial<TimelineEvent> & Pick<TimelineEvent, 'seq' | 'ts' | 'kind'>): TimelineEvent {
  return {
    sessionId: 's-test',
    agentId: null,
    uuid: `u-${p.seq}`,
    parentUuid: null,
    turn: 1,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
    ...p,
  };
}

export function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
  return { input, output, cacheRead, cacheWrite, costUsd: null };
}
