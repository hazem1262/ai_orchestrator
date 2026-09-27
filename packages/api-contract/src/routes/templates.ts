import { z } from 'zod';
import { SourceSchema } from '../domain.ts';

/** GET /api/templates response item. `prompt` is user/admin-authored template text (like a saved
 * view name), not transcript-derived, so it is not subject to the transcript-redaction boundary. */
export const TemplateVarSchema = z.enum(['ticket', 'ticketUrl', 'prUrl', 'file', 'check']);
export type TemplateVar = z.infer<typeof TemplateVarSchema>;

export const TemplateSchema = z.object({
  id: z.string(),
  kind: z.enum(['workflow', 'preset']),
  label: z.string(),
  prompt: z.string(),
  vars: z.array(TemplateVarSchema),
  defaultSource: SourceSchema,
  projectIds: z.union([z.array(z.string()), z.literal('all')]),
});
export type TemplateDto = z.output<typeof TemplateSchema>;
export type Template = TemplateDto;
