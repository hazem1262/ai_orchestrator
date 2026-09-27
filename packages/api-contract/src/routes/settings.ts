import { z } from 'zod';
import { DigestConfig, HooksConfig, LimitsConfig, RecapsConfig } from '../config.ts';

export const SettingsSchema = z.object({
  recaps: RecapsConfig,
  limits: LimitsConfig,
  digest: DigestConfig,
  hooks: HooksConfig,
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Each section is sent whole (PUT semantics per section); omitted sections are left unchanged. */
export const SettingsUpdateBody = z.object({
  recaps: RecapsConfig.optional(),
  limits: LimitsConfig.optional(),
  digest: DigestConfig.optional(),
  hooks: HooksConfig.optional(),
});
export type SettingsUpdateBody = z.infer<typeof SettingsUpdateBody>;
