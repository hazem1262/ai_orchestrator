import { describe, expect, it } from 'vitest';
import { ProjectPatchSchema } from './projects.ts';
import { PtyClientMessageSchema } from './pty.ts';
import {
  LabelRequestSchema,
  ResumeRequestSchema,
  ResumeResponseSchema,
  SessionEventsQuerySchema,
  SessionListQuerySchema,
} from './sessions.ts';

describe('SessionListQuerySchema', () => {
  it('coerces URL query strings', () => {
    const q = SessionListQuerySchema.parse({
      q: 'weekend',
      projectId: 'wakecap',
      source: 'claude',
      minCost: '0.5',
      hasSubagents: 'true',
      touchedProd: 'false',
      limit: '25',
      availability: 'prompts-only',
      pinned: 'true',
    });
    expect(q).toEqual({
      q: 'weekend',
      projectId: 'wakecap',
      source: 'claude',
      minCost: 0.5,
      hasSubagents: true,
      touchedProd: false,
      limit: 25,
      availability: 'prompts-only',
      pinned: true,
    });
  });

  it('rejects bad values', () => {
    expect(SessionListQuerySchema.safeParse({ source: 'cursor' }).success).toBe(false);
    expect(SessionListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(SessionListQuerySchema.safeParse({ hasSubagents: 'yes' }).success).toBe(false);
  });
});

describe('other request schemas', () => {
  it('parses events query', () => {
    expect(SessionEventsQuerySchema.parse({ afterSeq: '10', limit: '50', agentId: 'ag1' })).toEqual({
      afterSeq: 10,
      limit: 50,
      agentId: 'ag1',
    });
  });

  it('parses resume bodies and responses', () => {
    expect(ResumeRequestSchema.parse({ mode: 'embedded', fork: true })).toEqual({
      mode: 'embedded',
      fork: true,
    });
    expect(ResumeRequestSchema.safeParse({ mode: 'tmux' }).success).toBe(false);
    expect(ResumeResponseSchema.parse({ ptyId: 'p1' })).toEqual({ ptyId: 'p1' });
    expect(ResumeResponseSchema.parse({ launched: 'external', command: 'cd /x && claude' })).toEqual({
      launched: 'external',
      command: 'cd /x && claude',
    });
  });

  it('trims labels and caps their size', () => {
    expect(LabelRequestSchema.parse({ labels: [' later '] })).toEqual({ labels: ['later'] });
    expect(LabelRequestSchema.safeParse({ labels: [''] }).success).toBe(false);
  });

  it('keeps project patches free of defaults', () => {
    expect(ProjectPatchSchema.parse({ hidden: true })).toEqual({ hidden: true });
    expect(ProjectPatchSchema.safeParse({ id: 'other' }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ pathPrefixes: ['relative'] }).success).toBe(false);
  });

  it('validates PTY client messages', () => {
    expect(PtyClientMessageSchema.parse({ t: 'in', d: 'ls\r' })).toEqual({ t: 'in', d: 'ls\r' });
    expect(PtyClientMessageSchema.parse({ t: 'resize', cols: 120, rows: 40 })).toEqual({
      t: 'resize',
      cols: 120,
      rows: 40,
    });
    expect(PtyClientMessageSchema.safeParse({ t: 'resize', cols: 0, rows: 40 }).success).toBe(false);
    expect(PtyClientMessageSchema.safeParse({ t: 'say', text: 'x' }).success).toBe(false);
  });
});
