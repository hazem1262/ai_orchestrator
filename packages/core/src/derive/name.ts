export const NAME_MAX = 80;

export function truncate(text: string, max: number = NAME_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

export interface NameInputs {
  agentName: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
}

/** agent-name → custom-title → ai-title → summary → first prompt (docs/04 A2 "Derivations"). */
export function deriveName(i: NameInputs): string | null {
  for (const v of [i.agentName, i.customTitle, i.aiTitle, i.summary, i.firstPrompt]) {
    if (v !== null && v.trim().length > 0) return truncate(v);
  }
  return null;
}
