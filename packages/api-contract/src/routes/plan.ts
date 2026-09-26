import { z } from 'zod';
import { Confirm } from './common.ts';

export const PlanApproveBody = z.object({ confirm: Confirm });
export const PlanRejectBody = z.object({ feedback: z.string().trim().min(1).max(8000), confirm: Confirm });
