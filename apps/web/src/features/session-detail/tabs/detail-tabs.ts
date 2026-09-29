// Tab ids and labels for the session detail page. Kept apart from SessionDetailTabs.tsx so the
// route's search schema can import them without pulling the tab components into the main chunk.

export const DETAIL_TAB_IDS = [
  'timeline',
  'terminal',
  'diff',
  'files',
  'agents',
  'usage',
  'links',
  'raw',
] as const;
export type DetailTab = (typeof DETAIL_TAB_IDS)[number];
/** `timeline` keeps its URL value (`?tab=timeline`) so existing links still land on the transcript. */
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'timeline', label: 'Transcript' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'diff', label: 'Diff' },
  { id: 'files', label: 'Files' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage' },
  { id: 'links', label: 'Links' },
  { id: 'raw', label: 'Raw' },
];

export interface DetailNavigation {
  tab?: DetailTab;
  agent?: string | null;
  file?: string | null;
}
