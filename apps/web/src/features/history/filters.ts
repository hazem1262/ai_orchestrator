import { ALL_PROJECTS, type SessionListFilters } from '@orc/api-contract';
import type { Availability, Source } from '@orc/core';

export interface HistorySearch {
  q?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  skill?: string;
  label?: string;
  minCost?: number;
  maxCost?: number;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  availability?: Availability;
}

const STRING_KEYS = ['q', 'ticket', 'pr', 'from', 'to', 'model', 'skill', 'label'] as const;
const NUMBER_KEYS = ['minCost', 'maxCost'] as const;
const BOOL_KEYS = ['hasSubagents', 'touchedProd', 'pinned', 'includeHidden', 'includeAutomated'] as const;
const SOURCES: readonly string[] = ['claude', 'codex', 'agnc'];
const AVAILABILITY: readonly string[] = ['resumable', 'archived', 'prompts-only', 'remote'];

export function parseHistorySearch(raw: Record<string, unknown>): HistorySearch {
  const out: HistorySearch = {};
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  for (const k of NUMBER_KEYS) {
    const v = raw[k];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  for (const k of BOOL_KEYS) {
    const v = raw[k];
    if (v === true || v === 'true') out[k] = true;
    else if (v === false || v === 'false') out[k] = false;
  }
  if (typeof raw.source === 'string' && SOURCES.includes(raw.source)) out.source = raw.source as Source;
  if (typeof raw.availability === 'string' && AVAILABILITY.includes(raw.availability)) {
    out.availability = raw.availability as Availability;
  }
  return out;
}

/** Drops empty strings, undefined and `false` toggles so URLs stay short. */
export function cleanSearch(s: HistorySearch): HistorySearch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === '' || v === false) continue;
    out[k] = v;
  }
  return out as HistorySearch;
}

/** Date inputs give YYYY-MM-DD; `to` must include the whole day. */
export function toListFilters(search: HistorySearch, projectId: string): SessionListFilters {
  const to = search.to && /^\d{4}-\d{2}-\d{2}$/.test(search.to) ? `${search.to}T23:59:59.999Z` : search.to;
  return { ...search, to, projectId: projectId === ALL_PROJECTS ? undefined : projectId, limit: 50 };
}

export function searchToViewQuery(search: HistorySearch): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanSearch(search))) q[k] = String(v);
  return q;
}

export function viewQueryToSearch(q: Record<string, string>): HistorySearch {
  return parseHistorySearch(q);
}
