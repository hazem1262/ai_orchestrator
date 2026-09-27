import type { Reminder } from '@orc/core';
import { z } from 'zod';

export const ReminderSchema: z.ZodType<Reminder> = z.object({
  id: z.string(),
  jobId: z.string(),
  sessionPk: z.string().nullable(),
  ticket: z.string().nullable(),
  text: z.string(),
  dueAt: z.string(),
  sendToSession: z.boolean(),
  state: z.enum(['pending', 'fired', 'cancelled']),
  createdAt: z.string(),
  firedAt: z.string().nullable(),
});

export const ReminderCreateBody = z
  .object({
    sessionPk: z.string().nullable().default(null),
    ticket: z.string().nullable().default(null),
    text: z.string().min(1).max(2000),
    dueAt: z.string().datetime().optional(),
    inMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .optional(),
    sendToSession: z.boolean().default(false),
  })
  .refine((b) => (b.dueAt === undefined) !== (b.inMinutes === undefined), {
    message: 'give exactly one of dueAt or inMinutes',
  })
  .refine((b) => !b.sendToSession || b.sessionPk !== null, { message: 'sendToSession needs sessionPk' });
export type ReminderCreateBody = z.input<typeof ReminderCreateBody>;
export const RemindersListQuery = z.object({
  state: z.string().optional(),
  sessionPk: z.string().optional(),
});
