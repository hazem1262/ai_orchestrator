import { z } from 'zod';

export const SecretFindingSchema = z.object({ line: z.number(), kind: z.string() });

export const SecretsFileReportSchema = z.object({
  path: z.string(),
  displayPath: z.string(),
  exists: z.boolean(),
  findings: z.array(SecretFindingSchema),
  error: z.string().nullable(),
});
export type SecretsFileReport = z.infer<typeof SecretsFileReportSchema>;

export const SecretsReportSchema = z.object({
  scannedAt: z.string(),
  totalFindings: z.number(),
  files: z.array(SecretsFileReportSchema),
});
export type SecretsReport = z.infer<typeof SecretsReportSchema>;

export const DenyCheckRequest = z.object({
  text: z.string().max(100_000),
  projectId: z.string().nullable().default(null),
});
export type DenyCheckRequest = z.infer<typeof DenyCheckRequest>;

export const DenyVerdictSchema = z.object({ denied: z.boolean(), reason: z.string().nullable() });
