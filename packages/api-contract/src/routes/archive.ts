import { z } from 'zod';
import { SourceSchema } from '../domain.ts';

export const RECOMMENDED_CLEANUP_SNIPPET = '{\n  "cleanupPeriodDays": 3650\n}';

/** GET /api/archive/status. `oldestTranscript` is an ISO timestamp (daemon-derived, not transcript
 * content), same exclusion class as `Session.transcriptPath`. */
export const ArchiveStatus = z.object({
  enabled: z.boolean(),
  files: z.number(),
  bytes: z.number(),
  oldestTranscript: z.string().nullable(),
  cleanupPeriodDays: z.number().nullable(),
  codec: z.enum(['zstd', 'gzip']),
  recommendedSnippet: z.string(),
});
export type ArchiveStatus = z.output<typeof ArchiveStatus>;

export const ArchiveRestoreBody = z.strictObject({
  source: SourceSchema,
  id: z.string().min(1),
  confirm: z.boolean().optional(),
});
export type ArchiveRestoreBody = z.output<typeof ArchiveRestoreBody>;

export const ArchiveRestoreResponse = z.object({ restored: z.array(z.string()) });
export type ArchiveRestoreResponse = z.output<typeof ArchiveRestoreResponse>;

/** POST /api/archive/sync response. */
export const ArchiveSyncResponse = z.object({ copied: z.number().int() });
export type ArchiveSyncResponse = z.output<typeof ArchiveSyncResponse>;
