import type { DeliverableFile, FileSummary, SessionStats, TurnStats } from '@orc/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { AuditQuery } from './routes/audit.ts';
import { DenyCheckRequest } from './routes/safety.ts';
import {
  type DeliverableFileSchema,
  ExportQuery,
  type FileSummarySchema,
  RawQuery,
  type SessionStatsSchema,
  type TurnStatsSchema,
} from './routes/session-detail.ts';

describe('phase 3 schemas', () => {
  it('match the core types exactly', () => {
    expectTypeOf<z.infer<typeof TurnStatsSchema>>().toEqualTypeOf<TurnStats>();
    expectTypeOf<z.infer<typeof SessionStatsSchema>>().toEqualTypeOf<SessionStats>();
    expectTypeOf<z.infer<typeof DeliverableFileSchema>>().toEqualTypeOf<DeliverableFile>();
    expectTypeOf<z.infer<typeof FileSummarySchema>>().toEqualTypeOf<FileSummary>();
  });

  it('coerces query strings with defaults', () => {
    expect(RawQuery.parse({ offset: '10' })).toEqual({ offset: 10, limit: 200 });
    expect(() => RawQuery.parse({ limit: '5000' })).toThrow();
    expect(AuditQuery.parse({ limit: '5', actor: 'user' })).toEqual({ limit: 5, actor: 'user' });
    expect(() => AuditQuery.parse({ actor: 'hacker' })).toThrow();
    expect(ExportQuery.parse({})).toEqual({ redact: 'true', confirm: 'false' });
    expect(DenyCheckRequest.parse({ text: 'rm -rf /' })).toEqual({ text: 'rm -rf /', projectId: null });
  });
});
