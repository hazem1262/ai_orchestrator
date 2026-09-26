import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export interface ShipSuggestionResult {
  message: string;
  title: string;
  body: string;
  base: string;
  branch: string;
  ticket: string | null;
}

export function useShipSuggest(cwd: string | null, sessionPk: string | null) {
  return useQuery<ShipSuggestionResult>({
    queryKey: ['ship-suggest', cwd, sessionPk],
    enabled: cwd !== null,
    queryFn: () => getApiClient().shipSuggest({ cwd: cwd ?? '', ...(sessionPk ? { sessionPk } : {}) }),
  });
}
