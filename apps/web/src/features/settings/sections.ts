import {
  Bell,
  Cable,
  FileClock,
  FolderKanban,
  Gauge,
  type LucideIcon,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';

export const SETTINGS_SECTION_IDS = [
  'projects',
  'notifications',
  'recaps',
  'limits',
  'supervisor',
  'connectors',
  'remote',
  'advanced',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'projects';

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}> = [
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'recaps', label: 'Recaps', icon: Sparkles },
  { id: 'limits', label: 'Limits & budgets', icon: Gauge },
  { id: 'supervisor', label: 'Supervisor', icon: ShieldCheck },
  { id: 'connectors', label: 'Connectors', icon: Cable },
  { id: 'remote', label: 'Remote & mobile', icon: Smartphone },
  { id: 'advanced', label: 'Archive & advanced', icon: FileClock },
];

export interface SettingsSearch {
  section?: SettingsSectionId;
}

export function isSettingsSection(v: unknown): v is SettingsSectionId {
  return typeof v === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(v);
}

/**
 * `?section=` is kept only when it names a known section; anything else falls back to the default.
 * The key is always returned: the router merges the validated object over the raw search, so an
 * omitted key would let an unknown raw value through.
 */
export function parseSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  return { section: isSettingsSection(search.section) ? search.section : undefined };
}
