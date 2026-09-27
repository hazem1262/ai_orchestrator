import { z } from 'zod';
import { HandoffSchema } from './streams.ts';

export const HandoffWithMarkdownSchema = z.object({ handoff: HandoffSchema, markdown: z.string() });
export const ResumeFreshBody = z.object({ confirm: z.boolean().optional() });
export const ResumeFreshResponseSchema = z.object({ ptyId: z.string() });
