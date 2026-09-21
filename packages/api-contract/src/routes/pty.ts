import { z } from 'zod';

export const PtyInfoSchema = z.object({
  id: z.string(),
  sessionPk: z.string().nullable(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  exitedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type PtyInfo = z.output<typeof PtyInfoSchema>;

export const PtyClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), d: z.string().max(65_536) }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
]);
export type PtyClientMessage = z.output<typeof PtyClientMessageSchema>;

export const PtyServerControlSchema = z.object({ t: z.literal('exit'), code: z.number().int().nullable() });
export type PtyServerControl = z.output<typeof PtyServerControlSchema>;
