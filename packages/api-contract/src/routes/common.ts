import { z } from 'zod';

export const Confirm = z.boolean().default(false);
export const IsoString = z.string().min(1);
