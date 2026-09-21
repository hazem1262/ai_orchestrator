import type { Availability } from '../types/session.ts';

export function deriveAvailability(i: { transcriptExists: boolean; archived: boolean }): Availability {
  if (i.transcriptExists) return 'resumable';
  if (i.archived) return 'archived';
  return 'prompts-only';
}
