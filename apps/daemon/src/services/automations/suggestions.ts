import type { Suggestion } from '@orc/api-contract';

export interface SuggestionService {
  list(state?: Suggestion['state']): Suggestion[];
  refresh(): Promise<{ added: number }>;
  accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>;
  dismiss(id: string): Suggestion;
  start(): () => void;
}
